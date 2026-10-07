'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');

/**
 * Cadastro real de materiais e EPIs (Bloco 9, Etapa C, Parte C2) — módulo
 * js/materiais.js com `fetch` injetado, entrada `materials` do mapa de
 * páginas, js/pagina-base.js e inspeção estática de pages/materials.html e
 * do início do Portal. A prova com PostgreSQL real está em
 * backend/test/integracao/frontend-materiais.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function carregarMateriais() {
  // eslint-disable-next-line global-require
  return require('../js/materiais');
}

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

let chamadas;
/** Servidor falso: uma resposta por chamada, na ordem; devolve a última quando acabam. */
function servidor(...respostas) {
  chamadas = [];
  let i = 0;
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const corpo = opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined;
      chamadas.push({ metodo: opcoes.method, caminho: new URL(url).pathname + new URL(url).search, corpo });
      const r = respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

const MATERIAL = {
  id: 77, empresaId: 3, nome: 'Botina de segurança', tipo: 'Botina de Segurança', tipoDescricao: null, fabricante: 'Bracol',
  caNumero: '38271', caValidade: '2027-01-31', prazoUsoDias: 180, unidade: 'par', estoqueMinimo: 5,
  categoria: 'EPI', codigoInterno: 'EPI-000245', descricao: 'Biqueira de composite', exigeTamanho: true, ativo: true,
};

const FORMULARIO = {
  nome: '  Botina de segurança  ', categoria: 'EPI', tipo: 'Botina de Segurança', tipoCustom: '',
  fabricante: 'Bracol', codigoInterno: ' EPI-000245 ', controleTamanho: 'grade',
  quantidadeComprada: '120', tamanhoEntrada: '42', caEntrada: ' 38271 ', caValidadeEntrada: '2027-01-31', unidade: 'Par', estoqueMinimo: '5',
  prazoUnidade: 'meses', prazo: '6', descricao: 'Biqueira de composite', registrarEntrada: 'sim',
};

beforeEach(() => servidor(resposta(201, { status: 'ok', material: MATERIAL })));

describe('formulário: prazo de uso convertido para dias, explicitamente', () => {
  test('dias ×1, meses ×30, anos ×365; o texto mostra o valor que será gravado', () => {
    const { formulario } = carregarMateriais();
    assert.equal(formulario.converterPrazo('45', 'dias'), 45);
    assert.equal(formulario.converterPrazo('6', 'meses'), 180);
    assert.equal(formulario.converterPrazo('2', 'anos'), 730);
    assert.equal(formulario.textoPrazo('6', 'meses'), '6 meses = 180 dias');
    assert.equal(formulario.textoPrazo('1', 'ano'.replace('ano', 'anos')), '1 ano = 365 dias');
    assert.equal(formulario.textoPrazo('45', 'dias'), '45 dias');
    assert.equal(formulario.textoPrazo('1', 'meses'), '1 mês = 30 dias');
  });

  test('valor vazio, zero, negativo, decimal ou unidade desconhecida: null (nada é gravado por adivinhação)', () => {
    const { formulario } = carregarMateriais();
    for (const [v, u] of [['', 'meses'], ['0', 'meses'], ['-3', 'dias'], ['1.5', 'anos'], ['6', 'semanas'], ['abc', 'dias']]) {
      assert.equal(formulario.converterPrazo(v, u), null, `${v} ${u}`);
      assert.equal(formulario.textoPrazo(v, u), '', `${v} ${u}`);
    }
  });
});

describe('formulário: corpo do POST /materiais montado só com o que o contrato aceita', () => {
  test('todos os campos: trim, tipo da lista, unidade em minúsculas, prazo em dias, controle de tamanho, três campos da 039; a quantidade comprada vira entrada separada com o CA do lote', () => {
    const { formulario } = carregarMateriais();
    const r = formulario.montarCorpo(FORMULARIO);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.corpo, {
      nome: 'Botina de segurança', categoria: 'EPI', tipo: 'Botina de Segurança', fabricante: 'Bracol', codigoInterno: 'EPI-000245',
      unidade: 'par', estoqueMinimo: 5, prazoUsoDias: 180, exigeTamanho: true, descricao: 'Biqueira de composite',
    });
    assert.deepEqual(r.entrada, { tamanho: '42', quantidade: 120, caNumero: '38271', caValidade: '2027-01-31' });
    assert.equal('quantidadeComprada' in r.corpo, false, 'nunca é atributo do material');
    assert.equal('empresaId' in r.corpo, false, 'a empresa vem da sessão');
  });

  test('tipo "Outros" envia "Outros" e o texto como descrição do tipo (12G-8); sem texto é erro do campo da descrição', () => {
    const { formulario } = carregarMateriais();
    const ok = formulario.montarCorpo({ ...FORMULARIO, tipo: 'Outros', tipoCustom: '  Perneira  ' });
    assert.deepEqual([ok.corpo.tipo, ok.corpo.tipoDescricao], ['Outros', 'Perneira']);
    const erro = formulario.montarCorpo({ ...FORMULARIO, tipo: 'Outros', tipoCustom: '   ' });
    assert.deepEqual([erro.ok, erro.erros.map((e) => e.campo)], [false, ['tipoDescricao']]);
  });

  test('opcionais vazios são omitidos (o servidor grava NULL); sem "Sim" não há entrada', () => {
    const { formulario } = carregarMateriais();
    // Sem categoria só existe "Outros" (12G-8); os demais opcionais vazios continuam omitidos.
    const r = formulario.montarCorpo({
      nome: 'Luva', categoria: '', tipo: 'Outros', tipoCustom: 'Luva de raspa', fabricante: '  ', codigoInterno: '', controleTamanho: 'grade',
      quantidadeComprada: '', tamanhoEntrada: '', unidade: 'Unidade', estoqueMinimo: '', prazoUnidade: 'meses', prazo: '6', descricao: '',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.corpo, { nome: 'Luva', tipo: 'Outros', tipoDescricao: 'Luva de raspa', unidade: 'unidade', prazoUsoDias: 180, exigeTamanho: true });
    assert.equal(r.entrada, null);
  });

  test('erros por campo: nome, prazo, estoque mínimo, quantidade, tamanho, CA e validade da entrada, limites de tamanho', () => {
    const { formulario } = carregarMateriais();
    const campos = (r) => r.erros.map((e) => e.campo).sort();
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, nome: '   ' })), ['nome']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, prazo: '0' })), ['prazo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, prazo: '' })), ['prazo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '-1' })), ['estoqueMinimo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, tamanhoEntrada: '' })), ['tamanhoEntrada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '1.5' })), ['quantidadeComprada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '-2' })), ['quantidadeComprada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, caValidadeEntrada: '31/01/2027' })), ['caValidadeEntrada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, caEntrada: 'x'.repeat(21) })), ['caEntrada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, nome: 'x'.repeat(151) })), ['nome']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, codigoInterno: 'x'.repeat(31) })), ['codigoInterno']);
    // Categoria fora das listas só aceita "Outros": o tipo da lista de EPI também é recusado (12G-8).
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, categoria: 'x'.repeat(31) })), ['categoria', 'tipo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, descricao: 'x'.repeat(501) })), ['descricao']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, tamanhoEntrada: 'x'.repeat(21) })), ['tamanhoEntrada']);
    const varios = formulario.montarCorpo({ ...FORMULARIO, nome: '', prazo: 'abc', tamanhoEntrada: '' });
    assert.deepEqual([varios.ok, campos(varios)], [false, ['nome', 'prazo', 'tamanhoEntrada']]);
    assert.equal(varios.corpo, undefined, 'com erro nada é enviado');
  });

  test('tamanhos sugeridos pelo tipo só ordenam a lista: calçado 34–44, luva PP–GG, demais nenhum; a lista padrão não tem "Único"', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.tamanhosSugeridos('Sapatão / Botina'), ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44']);
    assert.deepEqual(formulario.tamanhosSugeridos('Luva'), ['PP', 'P', 'M', 'G', 'GG']);
    for (const tipo of ['Capacete', 'Perneira de raspa', '']) assert.deepEqual(formulario.tamanhosSugeridos(tipo), []);
    assert.deepEqual(formulario.TAMANHOS_GRADE, ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', 'PP', 'P', 'M', 'G', 'GG']);
  });
});

describe('mensagens: cada código do backend vira texto claro, sem vazar o corpo', () => {
  test('cadastro: 403, 409 código duplicado, 400 VALIDACAO com os campos, rede, 401 exige novo login', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroCadastro({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /não pode cadastrar materiais nesta empresa/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 409, codigo: 'MATERIAL_CODIGO_INTERNO_DUPLICADO' }), /código interno/i);
    const validacao = mensagens.erroCadastro({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.prazoUsoDias', codigo: 'CAMPO_OBRIGATORIO' }, { caminho: 'nome' }] });
    assert.match(validacao, /prazoUsoDias/);
    assert.match(validacao, /nome/);
    assert.match(mensagens.erroCadastro({ ok: false, status: 0, codigo: null }), /rede/i);
    // 5xx não é recusa: resultado não confirmado; a mensagem genérica fica para 4xx sem código próprio.
    assert.match(mensagens.erroCadastro({ ok: false, status: 500, codigo: 'ERRO_INTERNO' }), /não foi possível confirmar se o material foi cadastrado/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 422, codigo: 'OUTRO' }), /Não foi possível cadastrar/i);
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 401 }), true);
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 403 }), false);
  });

  test('entrada inicial: 403 sem MOVIMENTAR_ESTOQUE, material inativo, validação, rede; e o resultado combinado do cadastro', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroEntrada({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /movimentar estoque/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 409, codigo: 'MATERIAL_INATIVO' }), /inativo/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ caminho: 'quantidade' }] }), /quantidade/);
    assert.match(mensagens.erroEntrada({ ok: false, status: 0 }), /rede/i);

    assert.equal(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: false } }), 'Material cadastrado com sucesso. Registrado sem quantidade em estoque: nenhuma entrada inicial foi feita.');
    assert.equal(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: true, tamanho: '42', quantidade: 120 } }),
      'Material cadastrado com sucesso. Entrada inicial registrada: 120 no tamanho 42.');
    assert.equal(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: true, quantidade: 12 } }),
      'Material cadastrado com sucesso. Entrada inicial registrada: 12 (tamanho único).');
    const semPermissao = mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'SEM_PERMISSAO' } });
    assert.match(semPermissao, /^Material cadastrado com sucesso\. Entrada inicial não realizada: /);
    assert.match(semPermissao, /movimentar estoque/i);
    const recusada = mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'RECUSADA', resposta: { ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.caValidade', codigo: 'CA_VENCIDO' }] } } });
    assert.match(recusada, /^Material cadastrado com sucesso\. Entrada inicial não realizada: /);
    assert.match(recusada, /CA vencido/);
  });

  test('falha na consulta do estoque é um estado próprio: nem "sem estoque" nem saldo', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroEstoque({ ok: false, status: 0, codigo: null }), /rede/i);
    assert.match(mensagens.erroEstoque({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /não pode consultar o estoque/i);
    assert.match(mensagens.erroEstoque({ ok: false, status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }), /não encontrado nesta empresa/i);
    assert.match(mensagens.erroEstoque({ ok: false, status: 500, codigo: 'ERRO_INTERNO' }), /Não foi possível consultar/i);
  });
});

describe('fluxo: cadastro e entrada inicial são duas operações, na ordem certa, sem desfazer nem repetir', () => {
  const corpo = { nome: 'Botina', unidade: 'par', prazoUsoDias: 180, exigeTamanho: true };
  const entrada = { tamanho: '42', quantidade: 120, caNumero: '38271', caValidade: '2027-01-31' };
  const loteCriado = () => resposta(201, { status: 'ok', repetida: false, operacao: { id: '1', tipo: 'ENTRADA', loteId: 5 }, lote: { loteId: 5, tamanho: '42', saldo: 120 } });

  test('sem entrada: só POST /materiais', async () => {
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada: null, podeMovimentar: true });
    assert.deepEqual([r.ok, r.material.id, r.entrada.solicitada], [true, 77, false]);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais']);
    assert.deepEqual(chamadas[0].corpo, corpo);
  });

  test('com entrada e MOVIMENTAR_ESTOQUE: POST /materiais e DEPOIS a entrada por lote, com CA, validade e chave', async () => {
    servidor(resposta(201, { status: 'ok', material: MATERIAL }), loteCriado());
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([r.ok, r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo, r.entrada.lote.loteId], [true, true, true, null, 5]);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais', 'POST /api/materiais/77/estoque/entradas']);
    assert.deepEqual(semChave(chamadas[1].corpo), semChave(entrada));
  });

  test('com entrada mas SEM MOVIMENTAR_ESTOQUE: o cadastro acontece, a entrada nem é tentada (o servidor recusaria com 403)', async () => {
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: false });
    assert.deepEqual([r.ok, r.material.id, r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo], [true, 77, true, false, 'SEM_PERMISSAO']);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais']);
  });

  test('cadastro ok e entrada recusada: o material fica, nada é apagado ou inativado, nenhuma nova tentativa', async () => {
    servidor(resposta(201, { status: 'ok', material: MATERIAL }), resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO', mensagem: 'x' }));
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([r.ok, r.material.id, r.entrada.realizada, r.entrada.motivo, r.entrada.resposta.status], [true, 77, false, 'RECUSADA', 403]);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais', 'POST /api/materiais/77/estoque/entradas']);
    assert.equal(chamadas.some((c) => c.metodo === 'DELETE' || /inativar/.test(c.caminho)), false);
  });

  test('cadastro recusado (409 código duplicado): nenhuma entrada é tentada; falha de rede idem, com status 0', async () => {
    servidor(resposta(409, { status: 'erro', codigo: 'MATERIAL_CODIGO_INTERNO_DUPLICADO', mensagem: 'x' }));
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([r.ok, r.etapa, r.resposta.status, r.resposta.codigo], [false, 'cadastro', 409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO']);
    assert.equal(chamadas.length, 1);

    servidor(new TypeError('Failed to fetch'));
    const rede = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([rede.ok, rede.etapa, rede.resposta.status], [false, 'cadastro', 0]);
  });

  test('lista de materiais para o seletor: GET /materiais?ativo=true&limite=…, sem empresaId', async () => {
    servidor(resposta(200, { status: 'ok', materiais: [MATERIAL], total: 1, pagina: 1, limite: 100 }));
    const { acoes, render } = carregarMateriais();
    const r = await acoes.listar({ ativo: true, limite: 100 });
    assert.equal(r.ok, true);
    assert.match(chamadas[0].caminho, /^\/api\/materiais\?/);
    assert.match(chamadas[0].caminho, /ativo=true/);
    assert.equal(/empresaId/.test(chamadas[0].caminho), false);
    const html = render.opcoesMateriais([{ ...MATERIAL, nome: 'A <script>' }]);
    assert.match(html, /<option value="77">A &lt;script&gt; · EPI-000245<\/option>/);
  });
});

describe('permissões: a página de materiais no mapa PAGINAS (extensão da C1 por recurso)', () => {
  const p = (visualizar, criar, entrada, baixa = false) => ({
    recursos: { materials: { visualizar, criar, editar: false, excluir: false } },
    acoes: { ENTRADA_ESTOQUE: entrada, BAIXA_ESTOQUE: baixa },
    administracao: {},
  });

  test('a Gestão de Estoque abre com QUALQUER um dos três acessos independentes (criar produto, entrada, baixa); só criar altera o cadastro', () => {
    assert.ok(P.PAGINAS.materials, 'entrada materials');
    assert.equal(P.podeAbrir(p(false, true, false), 'materials'), true, 'só Cadastrar Produto');
    assert.equal(P.podeAbrir(p(true, false, true), 'materials'), true, 'só Entrada por Lote');
    assert.equal(P.podeAbrir(p(true, false, false, true), 'materials'), true, 'só Registrar Baixa');
    assert.equal(P.podeAbrir(p(true, false, false, false), 'materials'), false, 'os três OFF: fechada, mesmo com visualizar');
    assert.equal(P.podeAlterar(p(true, false, true, true), 'materials'), false);
    assert.equal(P.podeAlterar(p(true, true, false), 'materials'), true);
    assert.equal(P.acao(p(true, true, true), 'ENTRADA_ESTOQUE'), true);
    assert.equal(P.acao(p(true, true, true, false), 'BAIXA_ESTOQUE'), false, 'uma ação não concede a outra');
    assert.equal(P.acao(p(true, true, false, true), 'ENTRADA_ESTOQUE'), false);
    assert.equal(P.podeAbrir(null, 'materials'), false);
    assert.equal(P.podeAbrir({ recursos: { materials: { visualizar: 'true' } }, acoes: {}, administracao: {} }, 'materials'), false, 'só true explícito');
  });

  test('as quatro páginas administrativas da C1 continuam exatamente como aprovadas', () => {
    assert.deepEqual(P.PAGINAS['grupos-acesso'], { abrir: [['gruposAcesso', 'consultar']], alterar: [['gruposAcesso', 'alterar']] });
    assert.deepEqual(P.PAGINAS['grupo-permissoes'], { abrir: [['permissoesGrupo', 'consultar'], ['gruposAcesso', 'consultar']], alterar: [['permissoesGrupo', 'alterar']] });
    assert.deepEqual(P.PAGINAS['grupo-usuarios'], { abrir: [['vinculosGrupo', 'consultar'], ['gruposAcesso', 'consultar']], alterar: [['vinculosGrupo', 'alterar']] });
    assert.deepEqual(P.PAGINAS['autorizacoes-individuais'], { abrir: [['autorizacoesIndividuais', 'consultar']], alterar: [] });
  });

  test('menu: o link da Gestão de Estoque aparece com qualquer um dos três acessos; com os três OFF ou permissões nulas fica oculto', () => {
    const link = { style: { display: '' }, getAttribute: (n) => (n === 'data-pagina' ? 'materials' : null) };
    P.aplicarMenu(p(false, false, false), [link]);
    assert.equal(link.style.display, 'none');
    P.aplicarMenu(p(true, false, false), [link]);
    assert.equal(link.style.display, 'none', 'só visualizar o cadastro não abre a página');
    for (const permissoes of [p(false, true, false), p(false, false, true), p(false, false, false, true)]) {
      P.aplicarMenu(permissoes, [link]);
      assert.equal(link.style.display, '');
      link.style.display = 'none';
    }
    P.aplicarMenu(null, [link]);
    assert.equal(link.style.display, 'none');
  });
});

describe('pagina-base: utilitários copiados de main.js, sem estado e sem armazenamento', () => {
  test('toggleSidebar/closeMobileMenu alternam a classe do body; showToast cria e remove o aviso', () => {
    // eslint-disable-next-line global-require
    const B = require('../js/pagina-base');
    const classes = new Set();
    const doc = {
      body: {
        classList: { toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)), remove: (c) => classes.delete(c) },
        appendChild: (el) => { doc.anexados.push(el); },
      },
      anexados: [],
      createElement: () => ({ style: {}, textContent: '', remove() { doc.removidos += 1; } }),
      removidos: 0,
    };
    B.toggleSidebar(doc);
    assert.equal(classes.has('mobile-menu-open'), true);
    B.toggleSidebar(doc);
    assert.equal(classes.has('mobile-menu-open'), false);
    B.toggleSidebar(doc);
    B.closeMobileMenu(doc);
    assert.equal(classes.has('mobile-menu-open'), false);

    const temporizadores = [];
    const t = B.showToast('Salvo', 'success', doc, (fn) => temporizadores.push(fn));
    assert.equal(doc.anexados.length, 1);
    assert.equal(t.textContent, 'Salvo');
    assert.match(t.style.cssText, /#34C759/);
    temporizadores[0]();
    assert.equal(doc.removidos, 1);
  });

  test('o arquivo não lê nem grava nada no navegador e não depende de main.js/db-api.js', () => {
    const codigo = semComentarios(ler('js/pagina-base.js'));
    for (const proibido of [/localStorage/, /sessionStorage/, /document\.cookie/, /EpiAPI/, /STOCK_DATA/, /epi_db_v2/, /CURRENT_USER/, /kiosk/i]) {
      assert.equal(proibido.test(codigo), false, `pagina-base contém ${proibido}`);
    }
  });
});

describe('inspeção estática: pages/materials.html integrada, com a interface original preservada', () => {
  const html = ler('pages/materials.html');
  const codigo = semComentarios(html);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  test('sessão real da C0 no lugar do login simulado; sem db-api.js, main.js, xlsx, quiosque, Cobresul ou armazenamento local', () => {
    for (const proibido of [/loginScreen/, /doLogin/, /loginPanel/, /recoverPanel/, /biometric/i, /kiosk/i, /db-api\.js/, /main\.js/, /xlsx/, /Cobresul/i, /cobresul/i,
      /localStorage/, /sessionStorage/, /document\.cookie/, /epi_db_v2/, /EpiAPI/, /STOCK_DATA/, /cycleSizeChip/, /updateSizeChipsFromStockAPI/, /setActiveNav/, /showView\(/, /_s=/, /localhost:3000/]) {
      assert.equal(proibido.test(codigo), false, `materials.html contém ${proibido}`);
    }
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'aviso']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    // 12D-3: o painel do mínimo por tamanho é um módulo próprio, carregado depois do de materiais.
    // 12G-7: o catálogo visual desenha o pictograma do material escolhido.
    assert.deepEqual(scripts, ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/materiais.js', '../js/estoque-minimos.js', '../js/catalogo-visual.js']);
    assert.match(codigo, /EpiHttp\.configurar\(\{ baseUrl: window\.SAFEWORK_PORTAL_API_BASE_URL \}\)/);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'materials'/);
    assert.match(html, /SafeWork/);
  });

  test('campos do cadastro: os originais que continuam, o controle de tamanho, a entrada inicial com CA e o seletor de material do estoque', () => {
    for (const id of ['materialNome', 'materialCategoria', 'materialTipo', 'customMaterialTypeField', 'materialTipoCustom', 'materialFabricante',
      'materialCodigo', 'materialControleTamanho', 'materialQuantidadeComprada', 'materialEntradaCa', 'materialEntradaCaValidade', 'materialUnidade',
      'materialEstoqueMinimo', 'validityFields', 'materialValidadeTipo', 'materialPrazo', 'materialPrazoLabel', 'materialPrazoHelper', 'materialPrazoPreview',
      'materialPrazoPreviewText', 'materialDocumentoValidade', 'materialDesc', 'stockSummaryText', 'materialTamanhoEntrada', 'gradeMaterial', 'botaoLimpar', 'botaoSalvar']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    assert.match(html, /<input id="materialEntradaCaValidade" class="input" type="date"/);
    assert.match(html, /<select id="materialTamanhoEntrada" class="select"/);
    assert.match(html, /<select id="gradeMaterial" class="select"/);
    assert.match(html, /<input id="materialDocumentoValidade" class="input" type="file"[^>]*disabled/);
    assert.match(html, /em desenvolvimento/i);
    for (const opcao of ['EPI', 'Uniforme', 'Ferramenta', 'Material de consumo', 'Par', 'Unidade', 'Caixa', 'Pacote', 'Kit']) {
      assert.match(html, new RegExp(`<option[^>]*>${opcao.replace(/[/]/g, '\\/')}</option>`), `opção ${opcao}`);
    }
    assert.match(html, /<button id="botaoLimpar" class="outlined-btn" type="button">Limpar<\/button>/);
    assert.match(html, /<button id="botaoSalvar" class="filled-btn" type="button"[^>]*><span class="material-symbols-outlined">save<\/span>Salvar material<\/button>/);
    assert.equal(/Exemplos de tipos|Base inicial para organizar/.test(html), false, 'o quadro "Exemplos de tipos" saiu da tela');
    assert.match(html, /Estoque por lote/);
    assert.equal(/Atualiza automaticamente ao lançar entradas em Compras/.test(html), false, 'texto do simulado substituído');
    assert.equal((html.match(/class="size-chip/g) || []).length, 0, 'a grade antiga de chips saiu');
  });

  test('menu: estrutura original preservada; integrados com data-pagina ocultos; demais sem link e com "Em integração"; nenhum link para o protótipo', () => {
    for (const secao of ['Visão geral', 'Estoque', 'Entregas', 'Solicitações', 'Administração']) assert.match(html, new RegExp(`<div class="nav-section">${secao}</div>`));
    const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
    assert.deepEqual(links.map((m) => m[1]).sort(), ['autorizacoes-individuais', 'availableItems', 'config', 'dashboard', 'employeeGroups', 'employeeHistory', 'epiFicha', 'gestaoUsuarios', 'grupo-permissoes', 'grupo-usuarios', 'grupos-acesso', 'importEmployees', 'materials', 'newUser', 'operations', 'request', 'stockRequests', 'stockValidity', 'supervisorApproval', 'userAdmin']);
    for (const m of links) assert.match(m[0], /style="display:none"/, `${m[1]} deve nascer oculto`);
    assert.equal(/data-page=/.test(html), false, 'o mapa de arquivos do protótipo saiu');
    const pendentes = [...html.matchAll(/<a class="nav-pendente"[^>]*>[\s\S]*?<\/a>/g)];
    assert.ok(pendentes.length >= 8, `itens não integrados presentes (${pendentes.length})`); // E7: Validade; E8: Operações; F: Novo Usuário e Administração de Usuários; 10I: Ficha de EPI; 12G-1: as três da solicitação
    for (const m of pendentes) {
      assert.equal(/href=/.test(m[0]), false, 'não integrado não tem link');
      assert.match(m[0], /Em integração/);
    }
    for (const rotulo of ['Relatórios', 'Operações', 'Regras Função / Setor', 'Compras / Entradas', 'Validade de estoque', 'Análise de estoque', 'EPIs Entregues', 'Ficha de EPI', 'Histórico de Funcionários', 'Autoatendimento (Totem)', 'Pedido de EPI', 'Aprovação da Segurança do Trabalho', 'Entregas por solicitação', 'Importar Funcionários', 'Novo Usuário', 'Administração de Usuários', 'Configurações', 'Suporte', 'Gestão de E-mails', 'Privacidade / LGPD']) {
      assert.ok(html.includes(rotulo), `rótulo ${rotulo} preservado`);
    }
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('http') && !h.startsWith('../css/') && h !== 'javascript:void(0)');
    const permitidos = new Set(['available-items.html', 'stock-validity.html', 'operations.html', 'dashboard.html', 'employee-groups.html', 'epi-ficha.html', 'employee-history.html', 'import-employees.html', 'request.html', 'supervisor-approval.html', 'stock-requests.html', 'grupos-acesso.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'autorizacoes-individuais.html', 'new-user.html', 'user-admin.html', 'gestao-usuarios.html', 'config.html', '../portal/index.html', '../portal/inicio.html']);
    for (const h of hrefs) assert.ok(permitidos.has(h), `materials.html aponta para ${h}`);
    assert.match(html, /onclick="toggleSidebar\(\)"/);
    assert.match(html, /onclick="closeMobileMenu\(\)"/);
  });

  test('portal/inicio: Gestão de estoque entra nos módulos integrados (oculto até a permissão) e sai da lista "Em integração"', () => {
    const inicio = ler('portal/inicio.html');
    assert.match(inicio, /<a href="\.\.\/pages\/materials\.html" data-pagina="materials" style="display:none">Gestão de estoque<\/a>/);
    const emIntegracao = inicio.slice(inicio.indexOf('Em integração'));
    assert.equal(/Gestão de estoque/.test(emIntegracao), false);
    // 12G-5: o Estoque já está integrado e saiu de vez da lista "Em integração".
    assert.equal(/\bEstoque\b/.test(emIntegracao), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Correções da auditoria C2 (24/09/2026): mensagens preservadas após
// limpar, paginação do seletor, limites INTEGER no cliente e resultado
// não confirmado (rede / 5xx) distinto de recusa.
// ═══════════════════════════════════════════════════════════════════

const vm = require('node:vm');
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };

const totaisDe = (lotes) => lotes.reduce((t, l) => ({ fisico: t.fisico + l.fisico, bloqueado: t.bloqueado + l.bloqueado, disponivel: t.disponivel + l.disponivel }), { fisico: 0, bloqueado: 0, disponivel: 0 });

/** Servidor falso por rota (não por sequência), para os testes de página. */
function servidorRotas(estado) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      const corpo = opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined;
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo });
      const r = estado.responder(opcoes.method, u, corpo);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

function estadoPadrao(extra = {}) {
  const e = {
    materiais: [], saldos: [], lotes: [], proximoId: 999, proximoLote: 500,
    criar(corpo) { const m = { ...MATERIAL, ...corpo, id: e.proximoId }; return resposta(201, { status: 'ok', material: m }); },
    materialEstoque: {},
    estoqueLotes(id) { return resposta(200, { status: 'ok', material: { ...MATERIAL, ...e.materialEstoque, id }, hoje: '2026-09-30', diasAlerta: 60, lotes: e.lotes, totais: totaisDe(e.lotes) }); },
    entrada(id, corpo) {
      const lote = { loteId: e.proximoLote, materialId: id, tamanho: corpo.tamanho ?? null, caNumero: corpo.caNumero, caValidade: corpo.caValidade, origem: 'ENTRADA', quantidadeEntrada: corpo.quantidade, quantidadeBaixada: 0, quantidadeEntregue: 0, saldo: corpo.quantidade };
      return resposta(201, { status: 'ok', repetida: false, operacao: { id: '1', tipo: 'ENTRADA', loteId: lote.loteId, quantidade: corpo.quantidade }, lote });
    },
    baixa(loteId, corpo) { return resposta(201, { status: 'ok', repetida: false, operacao: { id: '2', tipo: 'BAIXA', loteId, quantidade: corpo.quantidade, motivo: corpo.motivo }, lote: { loteId, saldo: 0 } }); },
    movimentar(id, corpo) { return resposta(200, { status: 'ok', saldo: { materialId: id, tamanho: corpo.tamanho, quantidade: corpo.quantidade } }); },
    buscar(id) { return resposta(200, { status: 'ok', material: { ...MATERIAL, id } }); },
    alterar(id, corpo) { return resposta(200, { status: 'ok', material: { ...MATERIAL, ...corpo, id } }); },
    responder(metodo, u, corpo) {
      const p = u.pathname;
      if (metodo === 'GET' && p === '/api/materiais') {
        const pagina = Number(u.searchParams.get('pagina') || 1); const limite = Number(u.searchParams.get('limite') || 20);
        return resposta(200, { status: 'ok', materiais: e.materiais.slice((pagina - 1) * limite, pagina * limite), total: e.materiais.length, pagina, limite });
      }
      if (metodo === 'POST' && p === '/api/materiais') return e.criar(corpo);
      let m = p.match(/^\/api\/materiais\/(\d+)\/estoque\/movimentar$/);
      if (m && metodo === 'POST') return e.movimentar(Number(m[1]), corpo);
      m = p.match(/^\/api\/materiais\/(\d+)\/estoque\/lotes$/);
      if (m && metodo === 'GET') return e.estoqueLotes(Number(m[1]));
      m = p.match(/^\/api\/materiais\/(\d+)\/estoque\/entradas$/);
      if (m && metodo === 'POST') return e.entrada(Number(m[1]), corpo);
      m = p.match(/^\/api\/estoque\/lotes\/(\d+)\/baixas$/);
      if (m && metodo === 'POST') return e.baixa(Number(m[1]), corpo);
      m = p.match(/^\/api\/materiais\/(\d+)\/estoque$/);
      if (m && metodo === 'GET') return resposta(200, { status: 'ok', material: { ...MATERIAL, id: Number(m[1]) }, saldos: e.saldos });
      m = p.match(/^\/api\/materiais\/(\d+)$/);
      if (m && metodo === 'GET') return e.buscar(Number(m[1]));
      if (m && metodo === 'PATCH') return e.alterar(Number(m[1]), corpo);
      return resposta(404, { status: 'erro', codigo: 'NAO_ENCONTRADO' });
    },
    ...extra,
  };
  return e;
}

/** Executa o script embutido de materials.html sobre um DOM mínimo simulado. */
function montarPagina({ permissoes = { recursos: { materials: { visualizar: true, criar: true, editar: false, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} }, podeAlterar = true } = {}) {
  const html = ler('pages/materials.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const SELECTS = new Set(['materialCategoria', 'materialTipo', 'materialUnidade', 'materialValidade', 'materialValidadeTipo', 'materialTamanhoEntrada', 'gradeMaterial', 'materialRegistrarEntrada', 'entradaTamanho',
    'materialControleTamanho', 'baixaLote', 'baixaMotivo']);
  const mapa = {};
  const elemento = (id) => {
    const listeners = {};
    return {
      id, value: '', checked: false, textContent: '', innerHTML: '', disabled: false, selectedIndex: 0, style: {}, atributos: {}, listeners,
      tagName: SELECTS.has(id) ? 'SELECT' : 'INPUT',
      // 12G-7: o pictograma do material escolhido entra por nós do DOM, nunca por innerHTML.
      hidden: false, filhos: [], replaceChildren(...nos) { this.filhos = nos; },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.atributos[k] = v; }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
      querySelector() { return elemento('form-grid'); }, querySelectorAll() { return []; },
    };
  };
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const toasts = [];
  const noSvg = (ns, tag) => ({
    namespaceURI: ns, tagName: tag, atributos: {}, filhos: [],
    setAttribute(k, v) { this.atributos[k] = String(v); }, appendChild(n) { this.filhos.push(n); return n; },
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElementNS: noSvg },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiMateriais: carregarMateriais(), EpiEstoqueMinimos: require('../js/estoque-minimos'), EpiCatalogoVisual: require('../js/catalogo-visual'), EpiPermissoes: { prepararPagina: async () => ({ permissoes, podeAlterar }), acao: P.acao, recurso: P.recurso, somenteLeitura() {} },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    showToast: (m, t) => toasts.push([m, t]), toasts, console, setTimeout, Promise, String, Number, Array, Object, JSON, crypto: globalThis.crypto,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click') => { for (const fn of (el(id).listeners[ev] || [])) await fn(); await esperar(); };
  const preencher = (campos) => { for (const [id, v] of Object.entries(campos)) el(id).value = v; };
  return { el, sandbox, esperar, disparar, preencher };
}

const FORMULARIO_DOM = {
  materialNome: 'Botina nova', materialCategoria: 'EPI', materialTipo: 'Botina de Segurança', materialControleTamanho: 'grade', materialUnidade: 'Par', materialEstoqueMinimo: '5',
  materialValidadeTipo: 'meses', materialPrazo: '6', materialQuantidadeComprada: '10', materialTamanhoEntrada: '42', materialEntradaCa: '38271',
  materialEntradaCaValidade: '2027-01-31', materialRegistrarEntrada: 'sim',
};

describe('correção 1 — a mensagem do cadastro sobrevive à limpeza do formulário', () => {
  test('cadastro ok com entrada recusada (403): o formulário é limpo, mas o aviso "Entrada inicial não realizada" permanece', async () => {
    const estado = estadoPadrao({ entrada: () => resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO', mensagem: 'x' }) });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(FORMULARIO_DOM);
    await pg.disparar('botaoSalvar');
    assert.equal(pg.el('materialNome').value, '', 'formulário limpo');
    assert.equal(pg.el('aviso').style.display, 'block', 'aviso visível');
    assert.match(pg.el('aviso').innerHTML, /Material cadastrado com sucesso\. Entrada inicial não realizada/);
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/api/materiais', '/api/materiais/999/estoque/entradas']);
  });

  test('cadastro ok sem entrada: a mensagem de sucesso permanece após a limpeza; o botão Limpar, esse sim, apaga o aviso', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({ ...FORMULARIO_DOM, materialQuantidadeComprada: '', materialRegistrarEntrada: 'nao' });
    await pg.disparar('botaoSalvar');
    assert.match(pg.el('aviso').innerHTML, /Material cadastrado com sucesso\./);
    await pg.disparar('botaoLimpar');
    assert.equal(pg.el('aviso').style.display, 'none');
  });
});

describe('correção 2 — o seletor da grade consulta além dos primeiros 100 materiais', () => {
  test('acoes.listarTodos: percorre as páginas de 100 até o total; devolve todos e "completo"', async () => {
    const estado = estadoPadrao();
    estado.materiais = Array.from({ length: 250 }, (_, i) => ({ ...MATERIAL, id: i + 1, nome: `M${i + 1}` }));
    servidorRotas(estado);
    const { acoes } = carregarMateriais();
    const r = await acoes.listarTodos({ ativo: true });
    assert.equal(r.ok, true);
    assert.deepEqual([r.dados.materiais.length, r.dados.total, r.dados.completo], [250, 250, true]);
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/materiais?ativo=true&pagina=1&limite=100', '/api/materiais?ativo=true&pagina=2&limite=100', '/api/materiais?ativo=true&pagina=3&limite=100']);
    assert.equal(r.dados.materiais[249].id, 250);
  });

  test('listarTodos: falha em qualquer página devolve a falha (nunca uma lista parcial como se fosse completa); página vazia encerra', async () => {
    const estado = estadoPadrao();
    estado.materiais = Array.from({ length: 150 }, (_, i) => ({ ...MATERIAL, id: i + 1 }));
    const original = estado.responder;
    estado.responder = (m, u, c) => (u.searchParams.get('pagina') === '2' ? resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }) : original(m, u, c));
    servidorRotas(estado);
    const { acoes } = carregarMateriais();
    const r = await acoes.listarTodos({ ativo: true });
    assert.deepEqual([r.ok, r.status], [false, 500]);

    const teimoso = estadoPadrao();
    teimoso.materiais = Array.from({ length: 50 }, (_, i) => ({ ...MATERIAL, id: i + 1 }));
    const orig2 = teimoso.responder;
    teimoso.responder = (m, u, c) => { const r2 = orig2(m, u, c); return { ...r2, text: async () => JSON.stringify({ ...JSON.parse(''), }) }; };
    teimoso.responder = (m, u, c) => resposta(200, { status: 'ok', materiais: u.searchParams.get('pagina') === '1' ? teimoso.materiais : [], total: 5000, pagina: 1, limite: 100 });
    servidorRotas(teimoso);
    const r2 = await acoes.listarTodos({ ativo: true });
    assert.deepEqual([r2.ok, r2.dados.materiais.length, r2.dados.completo, chamadas.length], [true, 50, false, 2], 'total mentiroso: para na página vazia e marca incompleto');
  });

  test('página: com 250 materiais ativos, o seletor lista os 250 e o recém-cadastrado fica selecionado, mesmo que a listagem ainda não o traga', async () => {
    const estado = estadoPadrao();
    estado.materiais = Array.from({ length: 250 }, (_, i) => ({ ...MATERIAL, id: i + 1, nome: `M${i + 1}`, codigoInterno: null }));
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    assert.equal((pg.el('gradeMaterial').innerHTML.match(/<option value="\d+">/g) || []).length, 250);
    pg.preencher({ ...FORMULARIO_DOM, materialQuantidadeComprada: '', materialRegistrarEntrada: 'nao' });
    await pg.disparar('botaoSalvar');
    assert.equal(pg.el('gradeMaterial').value, '999', 'recém-cadastrado selecionado');
    assert.match(pg.el('gradeMaterial').innerHTML, /<option value="999">Botina nova/);
    assert.ok(chamadas.some((c) => c.caminho === '/api/materiais/999/estoque/lotes'), 'estoque carregado para o novo material');
  });
});

describe('correção 3 — limites INTEGER validados antes do cadastro', () => {
  test('quantidade, estoque mínimo e prazo em dias acima de 2147483647 são erros do campo; no limite, aceitos', () => {
    const { formulario } = carregarMateriais();
    const campos = (r) => (r.ok ? [] : r.erros.map((e) => e.campo).sort());
    assert.equal(formulario.INTEGER_MAXIMO, 2147483647);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '2147483648' })), ['quantidadeComprada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '2147483648' })), ['estoqueMinimo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, prazo: '71582789', prazoUnidade: 'meses' })), ['prazo'], '71582789 × 30 > INTEGER');
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, prazo: '5883517', prazoUnidade: 'anos' })), ['prazo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '99999999999999999999' })), ['quantidadeComprada'], 'fora do inteiro seguro');
    const limite = formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '2147483647', estoqueMinimo: '2147483647', prazo: '2147483647', prazoUnidade: 'dias' });
    assert.equal(limite.ok, true, JSON.stringify(limite));
    assert.deepEqual([limite.entrada.quantidade, limite.corpo.estoqueMinimo, limite.corpo.prazoUsoDias], [2147483647, 2147483647, 2147483647]);
  });

  test('página: quantidade acima do limite não inicia o cadastro (nenhuma requisição) e marca o campo', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    const antes = chamadas.length;
    pg.preencher({ ...FORMULARIO_DOM, materialQuantidadeComprada: '2147483648' });
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.length, antes, 'nenhuma operação parcial');
    assert.equal(pg.el('materialQuantidadeComprada').atributos['aria-invalid'], 'true');
    assert.match(pg.el('aviso').innerHTML, /Quantidade acima do limite/);
  });
});

describe('correção 4 — resultado não confirmado (rede / 5xx) é diferente de recusa', () => {
  const corpo = { nome: 'Botina', unidade: 'par', prazoUsoDias: 180, exigeTamanho: true };
  const entrada = { tamanho: '42', quantidade: 10, caNumero: '38271', caValidade: '2027-01-31' };

  test('cadastro: 409 é recusa confirmada; 503 e falha de rede são resultado não confirmado; nunca há nova tentativa', async () => {
    const { fluxo } = carregarMateriais();
    servidor(resposta(409, { status: 'erro', codigo: 'MATERIAL_CODIGO_INTERNO_DUPLICADO' }));
    const recusa = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([recusa.ok, recusa.etapa, recusa.confirmado, chamadas.length], [false, 'cadastro', true, 1]);

    servidor(resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' }));
    const incerto = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([incerto.ok, incerto.etapa, incerto.confirmado, incerto.resposta.status, chamadas.length], [false, 'cadastro', false, 503, 1]);

    servidor(new TypeError('Failed to fetch'));
    const rede = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([rede.ok, rede.confirmado, rede.resposta.status, chamadas.length], [false, false, 0, 1]);
  });

  test('entrada: 403 é RECUSADA; 500 e rede são NAO_CONFIRMADO, com uma única tentativa e o material preservado', async () => {
    const { fluxo } = carregarMateriais();
    servidor(resposta(201, { status: 'ok', material: MATERIAL }), resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' }));
    const recusada = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([recusada.ok, recusada.entrada.realizada, recusada.entrada.motivo], [true, false, 'RECUSADA']);

    servidor(resposta(201, { status: 'ok', material: MATERIAL }), resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }));
    const incerta = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([incerta.ok, incerta.material.id, incerta.entrada.realizada, incerta.entrada.motivo, incerta.entrada.resposta.status, chamadas.length], [true, 77, false, 'NAO_CONFIRMADO', 500, 2]);

    servidor(resposta(201, { status: 'ok', material: MATERIAL }), new TypeError('Failed to fetch'));
    const rede = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([rede.ok, rede.entrada.motivo, rede.entrada.resposta.status, chamadas.length], [true, 'NAO_CONFIRMADO', 0, 2]);
  });

  test('mensagens: cadastro não confirmado orienta a conferir a lista antes de repetir; entrada não confirmada preserva a identificação do material e orienta a conferir os lotes', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroCadastro({ ok: false, status: 503, codigo: 'INDISPONIVEL' }), /não foi possível confirmar se o material foi cadastrado/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 503, codigo: 'INDISPONIVEL' }), /antes de repetir/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 0 }), /rede/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 0 }), /não foi possível confirmar/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 409, codigo: 'MATERIAL_CODIGO_INTERNO_DUPLICADO' }), /código interno/i, 'recusa confirmada continua clara');

    const texto = mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'NAO_CONFIRMADO', resposta: { ok: false, status: 500, codigo: 'ERRO_INTERNO' }, tamanho: '42', quantidade: 10 } });
    assert.match(texto, /^Material cadastrado com sucesso/);
    assert.match(texto, /nº 77/);
    assert.match(texto, /EPI-000245/);
    assert.match(texto, /Entrada inicial não confirmada/);
    assert.match(texto, /Confira os lotes/);
    assert.match(texto, /não duplica/);
    assert.equal(/não realizada/.test(texto), false, 'não confirmado não é "não realizada"');
    assert.match(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'RECUSADA', resposta: { ok: false, status: 403 } } }), /Entrada inicial não realizada: /);
  });

  test('página: cadastro com resposta 503 mostra aviso de atenção com a orientação, sem repetir o POST, e recarrega a lista para conferência', async () => {
    const estado = estadoPadrao({ criar: () => resposta(503, { status: 'erro', codigo: 'INDISPONIVEL' }) });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    const listagensAntes = chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/materiais?')).length;
    pg.preencher(FORMULARIO_DOM);
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.filter((c) => c.metodo === 'POST').length, 1, 'um único POST');
    assert.match(pg.el('aviso').innerHTML, /não foi possível confirmar se o material foi cadastrado/i);
    assert.match(pg.el('aviso').innerHTML, /C07000/, 'aviso de atenção, não de erro definitivo');
    assert.ok(chamadas.filter((c) => c.metodo === 'GET' && c.caminho.startsWith('/api/materiais?')).length > listagensAntes, 'lista recarregada para conferência');
    assert.equal(pg.el('materialNome').value, 'Botina nova', 'formulário preservado: nada foi confirmado');
  });

  test('página: entrada com 500 mostra a identificação do material e a orientação, e carrega o estoque do material', async () => {
    const estado = estadoPadrao({ entrada: () => resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }) });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(FORMULARIO_DOM);
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.filter((c) => /entradas$/.test(c.caminho)).length, 1);
    assert.match(pg.el('aviso').innerHTML, /nº 999/);
    assert.match(pg.el('aviso').innerHTML, /Entrada inicial não confirmada/);
    assert.equal(pg.el('gradeMaterial').value, '999');
    assert.ok(chamadas.some((c) => c.caminho === '/api/materiais/999/estoque/lotes'));
  });
});

describe('12G-7 — Materiais: pictograma do material escolhido, ao lado do seletor', () => {
  const html = ler('pages/materials.html');
  const marcacao = html.slice(0, html.lastIndexOf('<script>'));
  const pictograma = (pg) => pg.el('pictogramaMaterialAtual');
  const chave = (pg) => (pictograma(pg).filhos[0] ? pictograma(pg).filhos[0].atributos['data-pictograma'] : null);

  test('estrutura: o espaço do pictograma fica na linha do seletor, antes dele, oculto e decorativo; nada mais da tela muda', () => {
    assert.match(marcacao, /<div style="display:flex;gap:8px;align-items:center">\s*<span id="pictogramaMaterialAtual" class="pictograma-material-atual" aria-hidden="true" hidden><\/span>\s*<select id="gradeMaterial" class="select" style="flex:1"><\/select>/);
    assert.equal((marcacao.match(/<[^>]*pictograma[^>]*>/g) || []).length, 1, 'um único espaço, só no estoque do material escolhido');
    assert.match(html, /EpiCatalogoVisual\.elemento\(document, /);
    assert.equal(/pictograma[^;\n]*innerHTML|innerHTML[^;\n]*Catalogo/.test(html), false, 'o pictograma nunca entra por innerHTML');
  });

  test('as opções do seletor de materiais continuam só texto (nenhum SVG dentro de <option>)', () => {
    const opcoes = carregarMateriais().render.opcoesMateriais([MATERIAL, { ...MATERIAL, id: 78, tipo: 'Luva' }]);
    assert.equal(/<svg/.test(opcoes), false);
  });

  test('ao escolher um material, o pictograma do tipo aparece ao lado do seletor; trocar para nenhum o tira', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    pg.el('gradeMaterial').value = '77';
    await pg.disparar('gradeMaterial', 'change');
    assert.equal(pictograma(pg).hidden, false);
    assert.equal(pictograma(pg).filhos.length, 1);
    const svg = pictograma(pg).filhos[0];
    assert.deepEqual([svg.namespaceURI, svg.tagName, svg.atributos['aria-hidden'], svg.atributos.focusable], ['http://www.w3.org/2000/svg', 'svg', 'true', 'false']);
    assert.equal(chave(pg), 'botina');
    pg.el('gradeMaterial').value = '';
    await pg.disparar('gradeMaterial', 'change');
    assert.deepEqual([pictograma(pg).hidden, pictograma(pg).filhos.length], [true, 0]);
  });

  test('tipo desconhecido usa a categoria e, sem categoria conhecida, o genérico (o mesmo catálogo das tabelas)', async () => {
    for (const [materialEstoque, esperada] of [[{ tipo: 'Avental', categoria: 'Uniforme' }, 'uniforme'], [{ tipo: 'Avental', categoria: null }, 'material']]) {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL], materialEstoque }));
      const pg = montarPagina();
      await pg.esperar();
      pg.el('gradeMaterial').value = '77';
      await pg.disparar('gradeMaterial', 'change');
      assert.equal(chave(pg), esperada);
    }
  });

  test('falha na consulta do estoque ou sessão encerrada: o pictograma sai junto com os saldos', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], estoqueLotes: () => resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }) }));
    const falha = montarPagina();
    await falha.esperar();
    falha.el('gradeMaterial').value = '77';
    await falha.disparar('gradeMaterial', 'change');
    assert.deepEqual([pictograma(falha).hidden, pictograma(falha).filhos.length], [true, 0]);

    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    pg.el('gradeMaterial').value = '77';
    await pg.disparar('gradeMaterial', 'change');
    assert.equal(pictograma(pg).filhos.length, 1);
    pg.sandbox.opcoesMontar.aoEncerrar();
    await pg.esperar();
    assert.deepEqual([pictograma(pg).hidden, pictograma(pg).filhos.length], [true, 0]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Melhoria da C2 (25/09/2026): edição de material existente na mesma
// tela (GET/PATCH /materiais/:id, que já existem), entrada inicial só com
// "Sim" explícito, tamanho nunca escolhido automaticamente, unidade de
// controle bloqueada na edição e validade do CA preservada.
// ═══════════════════════════════════════════════════════════════════

const PERMISSOES_EDITAR = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} };
const PERMISSOES_SO_EDITAR = { recursos: { materials: { visualizar: true, criar: false, editar: true, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} };
const MATERIAL_CA = { ...MATERIAL, caValidade: '2026-10-15' };
const pendente = () => { let resolver; const promessa = new Promise((r) => { resolver = r; }); return { promessa, resolver }; };

async function abrirEdicao(pg, id = 77) {
  pg.el('gradeMaterial').value = String(id);
  await pg.disparar('gradeMaterial', 'change');
  await pg.disparar('botaoEditarMaterial');
}

describe('melhoria C2 — módulo: carregar e editar material existente', () => {
  test('acoes.buscar e acoes.alterar usam o GET e o PATCH existentes em /materiais/:id, sem empresaId', async () => {
    const { acoes } = carregarMateriais();
    servidor(resposta(200, { status: 'ok', material: MATERIAL }));
    const b = await acoes.buscar(77);
    assert.deepEqual([b.ok, b.dados.material.id], [true, 77]);
    assert.deepEqual(chamadas, [{ metodo: 'GET', caminho: '/api/materiais/77', corpo: undefined }]);
    servidor(resposta(200, { status: 'ok', material: { ...MATERIAL, nome: 'X' } }));
    const a = await acoes.alterar(77, { nome: 'X' });
    assert.equal(a.ok, true);
    assert.deepEqual(chamadas, [{ metodo: 'PATCH', caminho: '/api/materiais/77', corpo: { nome: 'X' } }]);
  });

  test('prazo gravado em dias volta ao formulário em anos, meses ou dias, sem mudar o valor gravado', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.prazoParaCampos(null), { prazoUnidade: 'meses', prazo: '' });
    assert.deepEqual(formulario.prazoParaCampos(365), { prazoUnidade: 'anos', prazo: '1' });
    assert.deepEqual(formulario.prazoParaCampos(730), { prazoUnidade: 'anos', prazo: '2' });
    assert.deepEqual(formulario.prazoParaCampos(180), { prazoUnidade: 'meses', prazo: '6' });
    assert.deepEqual(formulario.prazoParaCampos(30), { prazoUnidade: 'meses', prazo: '1' });
    assert.deepEqual(formulario.prazoParaCampos(45), { prazoUnidade: 'dias', prazo: '45' });
    for (const dias of [1, 29, 30, 45, 180, 365, 400, 730, 10950]) {
      const c = formulario.prazoParaCampos(dias);
      assert.equal(formulario.converterPrazo(c.prazo, c.prazoUnidade), dias, `ida e volta de ${dias} dias`);
    }
  });

  test('datas: 15/10/2026 continua 15/10/2026 no campo (data pura ou data e hora em São Paulo ou UTC); o CA do cadastro não vai ao formulário', () => {
    const { formulario } = carregarMateriais();
    for (const v of ['2026-10-15', '2026-10-15T03:00:00.000Z', '2026-10-15T00:00:00.000Z']) {
      assert.equal(formulario.dataParaCampo(v), '2026-10-15', v);
    }
    for (const v of [null, undefined, '', '15/10/2026', 'lixo']) assert.equal(formulario.dataParaCampo(v), '', String(v));
    assert.equal('caValidade' in formulario.camposDoMaterial(MATERIAL_CA).campos, false);
  });

  test('camposDoMaterial: preenche o formulário com o registro real; tipo fora da lista vira "Outros" + descrição; valores fora das listas ganham opção temporária, nunca trocados em silêncio', () => {
    const { formulario } = carregarMateriais();
    const r = formulario.camposDoMaterial(MATERIAL);
    assert.deepEqual(r.campos, {
      nome: 'Botina de segurança', categoria: 'EPI', tipo: 'Botina de Segurança', tipoCustom: '', fabricante: 'Bracol', codigoInterno: 'EPI-000245',
      unidade: 'Par', estoqueMinimo: '5', prazoUnidade: 'meses', prazo: '6', controleTamanho: 'grade', grade: '', oculosComGrau: false, oculosComGrauTocado: false,
      descricao: 'Biqueira de composite', registrarEntrada: 'nao', quantidadeComprada: '', tamanhoEntrada: '', caEntrada: '', caValidadeEntrada: '',
    });
    assert.deepEqual(r.opcoesExtras, { categoria: null, tipo: null, unidade: null });
    const outro = formulario.camposDoMaterial({ ...MATERIAL, tipo: 'Perneira', categoria: null, unidade: 'rolo', caNumero: null, caValidade: null, fabricante: null, codigoInterno: null, descricao: null, prazoUsoDias: null });
    assert.deepEqual([outro.campos.tipo, outro.campos.tipoCustom, outro.campos.categoria, outro.campos.unidade], ['Outros', 'Perneira', '', 'rolo']);
    assert.deepEqual([outro.campos.fabricante, outro.campos.codigoInterno, outro.campos.descricao, outro.campos.prazo], ['', '', '', '']);
    assert.deepEqual(outro.opcoesExtras, { categoria: { valor: '', rotulo: 'Sem categoria' }, tipo: null, unidade: { valor: 'rolo', rotulo: 'rolo' } });
    assert.deepEqual(formulario.camposDoMaterial({ ...MATERIAL, tipo: null }).campos.tipo, '');
    assert.equal(formulario.camposDoMaterial({ ...MATERIAL, unidade: 'caixa' }).campos.unidade, 'Caixa');
    assert.deepEqual(formulario.camposDoMaterial({ ...MATERIAL, categoria: 'Químicos' }).opcoesExtras.categoria, { valor: 'Químicos', rotulo: 'Químicos' });
  });

  test('montarEdicao: nada alterado → nenhum campo; nome e fabricante alterados → PATCH só com esses dois; o CA do cadastro nunca vai', () => {
    const { formulario } = carregarMateriais();
    const campos = formulario.camposDoMaterial(MATERIAL_CA).campos;
    assert.deepEqual(formulario.montarEdicao(campos, MATERIAL_CA), { ok: true, corpo: {}, alterado: false });
    const r = formulario.montarEdicao({ ...campos, nome: ' Botina nova ', caNumero: '40000', caValidade: '2028-03-01', fabricante: '3M' }, MATERIAL_CA);
    assert.deepEqual(r, { ok: true, corpo: { nome: 'Botina nova', fabricante: '3M' }, alterado: true });
  });

  test('montarEdicao: validade do CA recebida como data e hora e não tocada não é reenviada', () => {
    const { formulario } = carregarMateriais();
    const original = { ...MATERIAL, caValidade: '2026-10-15T03:00:00.000Z' };
    const r = formulario.montarEdicao(formulario.camposDoMaterial(original).campos, original);
    assert.deepEqual(r, { ok: true, corpo: {}, alterado: false });
  });

  test('montarEdicao: opcional apagado vai como null; prazo equivalente não é reenviado; o prazo não pode ser apagado; novo prazo em dias', () => {
    const { formulario } = carregarMateriais();
    const campos = formulario.camposDoMaterial(MATERIAL).campos;
    const limpo = formulario.montarEdicao({ ...campos, fabricante: ' ', codigoInterno: '', descricao: '' }, MATERIAL);
    assert.deepEqual(limpo.corpo, { fabricante: null, codigoInterno: null, descricao: null });
    // Sem categoria só existe "Outros" (12G-8): apagar a categoria exige trocar o tipo junto.
    assert.deepEqual(formulario.montarEdicao({ ...campos, categoria: '' }, MATERIAL).erros.map((e) => e.campo), ['tipo']);
    assert.deepEqual(formulario.montarEdicao({ ...campos, categoria: '', tipo: 'Outros', tipoCustom: 'Botina importada' }, MATERIAL).corpo, { categoria: null, tipo: 'Outros', tipoDescricao: 'Botina importada' });
    assert.equal(formulario.montarEdicao({ ...campos, prazoUnidade: 'dias', prazo: '180' }, MATERIAL).alterado, false, '180 dias = 6 meses: nada muda');
    assert.equal(formulario.montarEdicao({ ...campos, definePrazo: 'nao', prazo: '' }, MATERIAL).ok, false);
    assert.deepEqual(formulario.montarEdicao({ ...campos, prazoUnidade: 'anos', prazo: '1' }, MATERIAL).corpo, { prazoUsoDias: 365 });
    assert.deepEqual(formulario.montarEdicao({ ...campos, estoqueMinimo: '0' }, MATERIAL).corpo, { estoqueMinimo: 0 });
  });

  test('montarEdicao: unidade nunca é enviada; quantidade, tamanho e "Sim" da entrada são ignorados; nada de empresaId', () => {
    const { formulario } = carregarMateriais();
    const campos = formulario.camposDoMaterial(MATERIAL).campos;
    const r = formulario.montarEdicao({ ...campos, unidade: 'Caixa', registrarEntrada: 'sim', quantidadeComprada: '50', tamanhoEntrada: '40', nome: 'Outro nome' }, MATERIAL);
    assert.deepEqual(r, { ok: true, corpo: { nome: 'Outro nome' }, alterado: true });
    assert.equal('entrada' in r, false);
    assert.deepEqual(formulario.montarEdicao({ ...campos, unidade: 'Caixa' }, MATERIAL), { ok: true, corpo: {}, alterado: false });
  });

  test('montarEdicao: mesmas validações do cadastro; estoque mínimo obrigatório; tipo vazio só é aceito se já era vazio', () => {
    const { formulario } = carregarMateriais();
    const campos = formulario.camposDoMaterial(MATERIAL).campos;
    const erros = (r) => (r.ok ? [] : r.erros.map((e) => e.campo).sort());
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, nome: '  ' }, MATERIAL)), ['nome']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, estoqueMinimo: '' }, MATERIAL)), ['estoqueMinimo']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, categoria: 'x'.repeat(31) }, MATERIAL)), ['categoria', 'tipo']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, controleTamanho: '' }, MATERIAL)), ['controleTamanho']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, prazo: '0' }, MATERIAL)), ['prazo']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, tipo: 'Outros', tipoCustom: '' }, MATERIAL)), ['tipoDescricao']);
    const semTipo = { ...MATERIAL, tipo: null };
    assert.deepEqual(formulario.montarEdicao(formulario.camposDoMaterial(semTipo).campos, semTipo), { ok: true, corpo: {}, alterado: false });
  });

  test('mensagens da edição: 403, 404, 409, 400, sem alteração, rede e 5xx (não confirmado), 401; nada do corpo vaza', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroEdicao({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /não pode editar materiais nesta empresa/i);
    assert.match(mensagens.erroEdicao({ ok: false, status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }), /não encontrado nesta empresa/i);
    assert.match(mensagens.erroEdicao({ ok: false, status: 409, codigo: 'MATERIAL_CODIGO_INTERNO_DUPLICADO' }), /código interno/i);
    assert.match(mensagens.erroEdicao({ ok: false, status: 400, codigo: 'MATERIAL_SEM_ALTERACAO' }), /Nenhuma alteração/i);
    const v = mensagens.erroEdicao({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ caminho: 'caValidade', valor: 'SEGREDO-123' }] });
    assert.match(v, /caValidade/);
    assert.equal(/SEGREDO-123/.test(v), false);
    for (const r of [{ ok: false, status: 0 }, { ok: false, status: 503, codigo: 'INDISPONIVEL' }]) {
      assert.match(mensagens.erroEdicao(r), /não foi possível confirmar se as alterações foram salvas/i);
    }
    assert.match(mensagens.erroEdicao({ ok: false, status: 401 }), /sessão terminou/i);
    assert.match(mensagens.erroCarregarEdicao({ ok: false, status: 404 }), /não encontrado nesta empresa/i);
    assert.match(mensagens.erroCarregarEdicao({ ok: false, status: 0 }), /rede/i);
    assert.match(mensagens.MSG.EDICAO_SUCESSO, /estoque não foi alterado/i);
  });
});

describe('melhoria C2 — módulo: entrada inicial só com "Sim" explícito', () => {
  test('"Não" (ou ausente): nenhuma entrada, mesmo com quantidade e tamanho preenchidos, e nenhum erro', () => {
    const { formulario } = carregarMateriais();
    for (const registrarEntrada of ['nao', undefined]) {
      const r = formulario.montarCorpo({ ...FORMULARIO, registrarEntrada });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.entrada, null, String(registrarEntrada));
    }
  });

  test('"Sim": quantidade maior que zero, tamanho escolhido, CA e validade são obrigatórios', () => {
    const { formulario } = carregarMateriais();
    const erros = (r) => (r.ok ? [] : r.erros.map((e) => e.campo).sort());
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '' })), ['quantidadeComprada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '0' })), ['quantidadeComprada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, tamanhoEntrada: '' })), ['tamanhoEntrada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '', tamanhoEntrada: '' })), ['quantidadeComprada', 'tamanhoEntrada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, caEntrada: '', caValidadeEntrada: '' })), ['caEntrada', 'caValidadeEntrada']);
    assert.deepEqual(formulario.montarCorpo(FORMULARIO).entrada, { tamanho: '42', quantidade: 120, caNumero: '38271', caValidade: '2027-01-31' });
  });
});

describe('melhoria C2 — inspeção estática: acréscimos mínimos ao HTML original', () => {
  const html = ler('pages/materials.html');
  const opcoes = (id) => {
    const bloco = html.slice(html.indexOf(`<select id="${id}"`), html.indexOf('</select>', html.indexOf(`<select id="${id}"`)));
    return [...bloco.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
  };

  test('botões Editar material e Cancelar edição, seletor da entrada inicial (padrão Não), identificação do modo edição e ajuda da unidade', () => {
    assert.match(html, /<button id="botaoEditarMaterial" class="outlined-btn" type="button" style="display:none" disabled>/);
    assert.match(html, /<button id="botaoCancelarEdicao" class="outlined-btn" type="button" style="display:none">Cancelar edição<\/button>/);
    assert.match(html, /<label for="materialRegistrarEntrada">Registrar entrada inicial de estoque\?<\/label>/);
    assert.match(html, /<select id="materialRegistrarEntrada" class="select">\s*<option value="nao" selected>Não[^<]*<\/option>\s*<option value="sim">Sim[^<]*<\/option>/);
    for (const id of ['materialRegistrarEntradaHelper', 'campoQuantidadeComprada', 'campoTamanhoEntrada', 'tituloFormulario', 'subtituloFormulario', 'modoEdicao', 'materialUnidadeHelper']) {
      assert.match(html, new RegExp(`id="${id}"`), `falta #${id}`);
    }
    assert.match(html, /<div class="field" id="campoQuantidadeComprada" style="display:none">/);
    assert.match(html, /<div class="field" id="campoTamanhoEntrada" style="display:none">/);
    assert.match(html, /<h2 id="tituloFormulario">Novo material \/ EPI<\/h2>/);
    assert.match(html, /<div class="helper" id="materialUnidadeHelper" style="display:none">A unidade de controle não pode ser alterada em um material existente\.<\/div>/);
    assert.equal((html.match(/id="materialNome"/g) || []).length, 1, 'um único formulário');
  });

  test('as listas do módulo são exatamente as opções do HTML (categoria, tipo, unidade)', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(opcoes('materialCategoria'), formulario.CATEGORIAS);
    // 12G-8: o tipo depende da categoria e é montado pela página (render.opcoesTipos); o HTML só tem o placeholder.
    assert.deepEqual(opcoes('materialTipo'), ['Selecione']);
    assert.deepEqual(formulario.tiposDe('EPI'), formulario.TIPOS_POR_CATEGORIA.EPI);
    assert.deepEqual(opcoes('materialUnidade'), formulario.UNIDADES);
  });

  test('sem inativar, reativar ou excluir; as rotas são as do cadastro e as do estoque por lote', () => {
    const codigo = semComentarios(ler('js/materiais.js'));
    assert.equal(/inativar|reativar|'DELETE'/.test(codigo), false);
    const rotas = [...codigo.matchAll(/requisitar\('([A-Z]+)', (.*?)(?:, \{ corpo: corpo \})?\);/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    assert.deepEqual(rotas, [
      "GET CAMINHO + '/' + encodeURIComponent(id)",
      "GET CAMINHO + '/' + encodeURIComponent(id) + '/estoque/lotes'",
      "GET CAMINHO + (q.length ? '?' + q.join('&') : '')",
      "PATCH CAMINHO + '/' + encodeURIComponent(id)",
      'POST CAMINHO',
      "POST CAMINHO + '/' + encodeURIComponent(id) + '/estoque/entradas'",
      "POST '/estoque/lotes/' + encodeURIComponent(loteId) + '/baixas'",
    ].sort());
  });
});

describe('melhoria C2 — página: editar material existente', () => {
  test('botão Editar material: oculto sem materials.editar; com editar, visível e habilitado só com um material escolhido', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const sem = montarPagina();
    await sem.esperar();
    assert.equal(sem.el('botaoEditarMaterial').style.display, 'none');
    await abrirEdicao(sem);
    assert.equal(chamadas.some((c) => c.caminho === '/api/materiais/77'), false, 'sem editar, nenhuma carga');

    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const com = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await com.esperar();
    assert.equal(com.el('botaoEditarMaterial').style.display, '');
    assert.equal(com.el('botaoEditarMaterial').disabled, true);
    com.el('gradeMaterial').value = '77';
    await com.disparar('gradeMaterial', 'change');
    assert.equal(com.el('botaoEditarMaterial').disabled, false);
  });

  test('entrar na edição: o registro real preenche o formulário, com prazo e controle de tamanho; título, identificação, Salvar alterações e Cancelar edição', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL_CA], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL_CA, id } }) }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    assert.ok(chamadas.some((c) => c.metodo === 'GET' && c.caminho === '/api/materiais/77'));
    const valores = Object.fromEntries(['materialNome', 'materialCategoria', 'materialTipo', 'materialFabricante', 'materialCodigo', 'materialControleTamanho',
      'materialUnidade', 'materialEstoqueMinimo', 'materialValidadeTipo', 'materialPrazo', 'materialDesc'].map((id) => [id, pg.el(id).value]));
    assert.deepEqual(valores, {
      materialNome: 'Botina de segurança', materialCategoria: 'EPI', materialTipo: 'Botina de Segurança', materialFabricante: 'Bracol', materialCodigo: 'EPI-000245',
      materialControleTamanho: 'grade', materialUnidade: 'Par', materialEstoqueMinimo: '5', materialValidadeTipo: 'meses', materialPrazo: '6', materialDesc: 'Biqueira de composite',
    });
    assert.equal(pg.el('materialPrazoPreviewText').textContent, '6 meses = 180 dias');
    assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
    assert.equal(pg.el('modoEdicao').style.display, '');
    assert.match(pg.el('modoEdicao').textContent, /Botina de segurança/);
    assert.match(pg.el('modoEdicao').textContent, /EPI-000245/);
    assert.match(pg.el('botaoSalvar').innerHTML, /Salvar alterações/);
    assert.equal(pg.el('botaoCancelarEdicao').style.display, '');
    assert.equal(pg.el('botaoLimpar').style.display, 'none');
  });

  test('na edição: unidade de controle visível e bloqueada; entrada inicial, quantidade e tamanho indisponíveis, com orientação', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    assert.deepEqual([pg.el('materialUnidade').value, pg.el('materialUnidade').disabled], ['Par', true]);
    assert.equal(pg.el('materialUnidadeHelper').style.display, '', 'ajuda da unidade visível (texto conferido na inspeção estática)');
    assert.deepEqual([pg.el('materialRegistrarEntrada').value, pg.el('materialRegistrarEntrada').disabled], ['nao', true]);
    assert.equal(pg.el('materialQuantidadeComprada').disabled, true);
    assert.equal(pg.el('materialTamanhoEntrada').disabled, true);
    assert.equal(pg.el('campoQuantidadeComprada').style.display, 'none');
    assert.match(pg.el('materialRegistrarEntradaHelper').textContent, /edição não altera o estoque/i);
    assert.equal(pg.el('materialNome').disabled, false);
  });

  test('Salvar alterações: PATCH só com os campos alterados, nenhuma movimentação; sucesso diz que o estoque não mudou, volta ao cadastro e recarrega o estoque', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher({ materialNome: 'Botina nova', materialPrazo: '8', materialFabricante: '3M' });
    const antes = chamadas.length;
    await pg.disparar('botaoSalvar');
    const depois = chamadas.slice(antes);
    assert.deepEqual(depois.filter((c) => c.metodo !== 'GET'), [{ metodo: 'PATCH', caminho: '/api/materiais/77', corpo: { nome: 'Botina nova', fabricante: '3M', prazoUsoDias: 240 } }]);
    assert.ok(depois.some((c) => c.caminho === '/api/materiais/77/estoque/lotes'), 'estoque recarregado');
    assert.match(pg.el('aviso').innerHTML, /estoque não foi alterado/i);
    assert.equal(pg.el('tituloFormulario').textContent, 'Novo material / EPI');
    assert.equal(pg.el('botaoCancelarEdicao').style.display, 'none');
    assert.equal(pg.el('materialUnidade').disabled, false);
    assert.equal(pg.el('materialNome').value, '');
  });

  test('nada alterado: nenhuma requisição de escrita, aviso "Nenhuma alteração"; continua em edição', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.some((c) => c.metodo === 'PATCH' || c.metodo === 'POST'), false);
    assert.match(pg.el('aviso').innerHTML, /Nenhuma alteração/);
    assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
  });

  test('unidade alterada à força no DOM durante a edição: nunca vai no PATCH', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher({ materialUnidade: 'Caixa', materialFabricante: 'Danny' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'PATCH').map((c) => c.corpo), [{ fabricante: 'Danny' }]);
  });

  test('Cancelar edição: nenhuma escrita, formulário limpo, volta ao modo cadastro com a unidade liberada', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher({ materialNome: 'Não salvar' });
    await pg.disparar('botaoCancelarEdicao');
    assert.equal(chamadas.some((c) => c.metodo === 'PATCH' || c.metodo === 'POST'), false);
    assert.equal(pg.el('materialNome').value, '');
    assert.equal(pg.el('tituloFormulario').textContent, 'Novo material / EPI');
    assert.equal(pg.el('modoEdicao').style.display, 'none');
    assert.match(pg.el('botaoSalvar').innerHTML, /Salvar material/);
    assert.deepEqual([pg.el('materialUnidade').disabled, pg.el('materialRegistrarEntrada').disabled], [false, false]);
    assert.equal(pg.el('botaoLimpar').style.display, '');
  });

  test('recusas: 403 e 404 mostram a mensagem e mantêm a edição; 409 marca o código interno; rede é "não confirmado", com um único PATCH', async () => {
    for (const [status, codigo, texto] of [[403, 'SEM_PERMISSAO', /não pode editar/i], [404, 'MATERIAL_NAO_ENCONTRADO', /não encontrado nesta empresa/i], [409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO', /código interno/i]]) {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL], alterar: () => resposta(status, { status: 'erro', codigo }) }));
      const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
      await pg.esperar();
      await abrirEdicao(pg);
      pg.preencher({ materialCodigo: 'EPI-1' });
      await pg.disparar('botaoSalvar');
      assert.match(pg.el('aviso').innerHTML, texto, String(status));
      assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI', `${status}: continua em edição`);
      if (status === 409) assert.equal(pg.el('materialCodigo').atributos['aria-invalid'], 'true');
    }
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], alterar: () => new TypeError('Failed to fetch') }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher({ materialNome: 'Rede caiu' });
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.filter((c) => c.metodo === 'PATCH').length, 1);
    assert.match(pg.el('aviso').innerHTML, /não foi possível confirmar se as alterações foram salvas/i);
    assert.match(pg.el('aviso').innerHTML, /C07000/);
    assert.equal(pg.el('materialNome').value, 'Rede caiu', 'formulário preservado');
  });

  test('falha ao carregar (404, rede): mensagem e nenhum dado no formulário; 401 devolve ao Portal', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: () => resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO' }) }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    assert.match(pg.el('aviso').innerHTML, /não encontrado nesta empresa/i);
    assert.equal(pg.el('materialNome').value, '');
    assert.notEqual(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: () => resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }) }));
    const pg2 = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg2.esperar();
    await abrirEdicao(pg2);
    assert.equal(pg2.sandbox.encerrada, true);
  });

  test('respostas antigas descartadas: Editar A (lenta) e depois B (rápida) → fica B; Cancelar ou encerrar a sessão durante a carga → nada é preenchido', async () => {
    const lenta = pendente();
    const B = { ...MATERIAL, id: 88, nome: 'Luva B' };
    servidorRotas(estadoPadrao({ materiais: [MATERIAL, B], buscar: (id) => (id === 77 ? lenta.promessa : resposta(200, { status: 'ok', material: B })) }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    pg.el('gradeMaterial').value = '77';
    const cargaA = pg.disparar('botaoEditarMaterial');
    await abrirEdicao(pg, 88);
    lenta.resolver(resposta(200, { status: 'ok', material: MATERIAL }));
    await cargaA;
    await pg.esperar();
    assert.equal(pg.el('materialNome').value, 'Luva B');
    assert.match(pg.el('modoEdicao').textContent, /Luva B/);

    const lenta2 = pendente();
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: () => lenta2.promessa }));
    const pg2 = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg2.esperar();
    pg2.el('gradeMaterial').value = '77';
    await pg2.disparar('gradeMaterial', 'change');
    const carga2 = pg2.disparar('botaoEditarMaterial'); // fica pendente até a resposta
    await pg2.esperar();
    await pg2.disparar('botaoCancelarEdicao');
    lenta2.resolver(resposta(200, { status: 'ok', material: MATERIAL }));
    await carga2;
    await pg2.esperar();
    assert.equal(pg2.el('materialNome').value, '', 'cancelado durante a carga');

    const lenta3 = pendente();
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: () => lenta3.promessa }));
    const pg3 = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg3.esperar();
    pg3.el('gradeMaterial').value = '77';
    await pg3.disparar('gradeMaterial', 'change');
    const carga3 = pg3.disparar('botaoEditarMaterial'); // fica pendente até a resposta
    await pg3.esperar();
    pg3.sandbox.opcoesMontar.aoEncerrar();
    lenta3.resolver(resposta(200, { status: 'ok', material: MATERIAL }));
    await carga3;
    await pg3.esperar();
    assert.equal(pg3.el('materialNome').value, '', 'sessão encerrada durante a carga');
    assert.equal(pg3.el('botaoEditarMaterial').style.display, 'none');
  });

  test('sessão encerrada em pleno modo edição: formulário limpo, fora da edição', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.equal(pg.el('materialNome').value, '');
    assert.equal(pg.el('modoEdicao').style.display, 'none');
  });

  test('perfil com editar e sem criar: formulário bloqueado no cadastro, liberado só na edição, bloqueado de novo ao cancelar', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_SO_EDITAR, podeAlterar: false });
    await pg.esperar();
    assert.deepEqual([pg.el('botaoSalvar').style.display, pg.el('materialNome').disabled, pg.el('botaoEditarMaterial').style.display], ['none', true, '']);
    await abrirEdicao(pg);
    assert.deepEqual([pg.el('botaoSalvar').style.display, pg.el('materialNome').disabled, pg.el('materialUnidade').disabled], ['', false, true]);
    pg.preencher({ materialFabricante: 'Danny' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'PATCH').map((c) => c.corpo), [{ fabricante: 'Danny' }]);
    await abrirEdicao(pg);
    await pg.disparar('botaoCancelarEdicao');
    assert.deepEqual([pg.el('botaoSalvar').style.display, pg.el('materialNome').disabled], ['none', true]);
  });
});

describe('melhoria C2 — página: entrada inicial de estoque', () => {
  test('padrão "Não": quantidade e tamanho ocultos; o tamanho começa vazio ("Selecione o tamanho"), sem escolha automática', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(pg.el('materialRegistrarEntrada').value, 'nao');
    assert.equal(pg.el('campoQuantidadeComprada').style.display, 'none');
    assert.equal(pg.el('campoTamanhoEntrada').style.display, 'none');
    assert.match(pg.el('materialTamanhoEntrada').innerHTML, /^<option value="">Selecione o tamanho<\/option>/);
    assert.equal(pg.el('materialTamanhoEntrada').value, '');
  });

  test('"Sim": os campos aparecem e o tamanho continua vazio, inclusive após trocar o tipo', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.el('materialRegistrarEntrada').value = 'sim';
    await pg.disparar('materialRegistrarEntrada', 'change');
    assert.deepEqual([pg.el('campoQuantidadeComprada').style.display, pg.el('campoTamanhoEntrada').style.display], ['', '']);
    assert.equal(pg.el('materialTamanhoEntrada').value, '');
    pg.el('materialTipo').value = 'Luva';
    await pg.disparar('materialTipo', 'change');
    assert.equal(pg.el('materialTamanhoEntrada').value, '');
    assert.match(pg.el('materialTamanhoEntrada').innerHTML, /^<option value="">Selecione o tamanho<\/option><option value="PP">/);
  });

  test('voltar para "Não" limpa quantidade e tamanho', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({ materialRegistrarEntrada: 'sim', materialQuantidadeComprada: '10', materialTamanhoEntrada: '42' });
    pg.el('materialRegistrarEntrada').value = 'nao';
    await pg.disparar('materialRegistrarEntrada', 'change');
    assert.deepEqual([pg.el('materialQuantidadeComprada').value, pg.el('materialTamanhoEntrada').value], ['', '']);
  });

  test('"Não": cadastro sem entrada, mesmo com quantidade no campo; a mensagem diz que ficou sem quantidade em estoque', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({ ...FORMULARIO_DOM, materialRegistrarEntrada: 'nao' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/api/materiais']);
    assert.match(pg.el('aviso').innerHTML, /sem quantidade em estoque/i);
  });

  test('"Sim" sem tamanho escolhido ou sem quantidade: nada é enviado e o campo é marcado', async () => {
    for (const [falta, campo] of [[{ materialTamanhoEntrada: '' }, 'materialTamanhoEntrada'], [{ materialQuantidadeComprada: '' }, 'materialQuantidadeComprada']]) {
      servidorRotas(estadoPadrao());
      const pg = montarPagina();
      await pg.esperar();
      pg.preencher({ ...FORMULARIO_DOM, ...falta });
      await pg.disparar('botaoSalvar');
      assert.equal(chamadas.some((c) => c.metodo === 'POST'), false, campo);
      assert.equal(pg.el(campo).atributos['aria-invalid'], 'true', campo);
    }
  });

  test('"Sim" completo: cadastro e entrada no tamanho escolhido', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(FORMULARIO_DOM);
    await pg.disparar('botaoSalvar');
    assert.deepEqual(chamadas.filter((c) => /entradas$/.test(c.caminho)).map((c) => [c.corpo.tamanho, c.corpo.quantidade, c.corpo.caNumero]), [['42', 10, '38271']]);
  });

  test('sem MOVIMENTAR_ESTOQUE: seletor em "Não", bloqueado, com o aviso', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina({ permissoes: { recursos: { materials: { visualizar: true, criar: true, editar: false, excluir: false } }, acoes: {}, administracao: {} } });
    await pg.esperar();
    assert.deepEqual([pg.el('materialRegistrarEntrada').value, pg.el('materialRegistrarEntrada').disabled], ['nao', true]);
    assert.match(pg.el('materialRegistrarEntradaHelper').textContent, /não pode movimentar estoque/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Entrada de estoque em material já cadastrado: cada entrada vira um
// lote, separada da edição cadastral (nunca PATCH).
// ═══════════════════════════════════════════════════════════════════

const PERMISSOES_SEM_MOVIMENTAR = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: {}, administracao: {} };
const ENTRADA_DOM = { entradaTamanho: '35', entradaQuantidade: '5', entradaCa: '38271', entradaCaValidade: '2027-01-31' };

async function escolherMaterial(pg, id = 77) {
  pg.el('gradeMaterial').value = String(id);
  await pg.disparar('gradeMaterial', 'change');
}

describe('entrada de estoque posterior — módulo', () => {
  const base = { tamanho: '35', quantidade: '5', caNumero: '38271', caValidade: '2027-01-31' };

  test('montarEntrada: tamanho e quantidade aparados; limites de quantidade e de tamanho; nada de empresaId', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.montarEntrada({ ...base, tamanho: ' 35 ', quantidade: ' 5 ' }, true), { ok: true, corpo: { tamanho: '35', quantidade: 5, caNumero: '38271', caValidade: '2027-01-31' } });
    const erros = (r) => (r.ok ? [] : r.erros.map((e) => e.campo).sort());
    assert.deepEqual(erros(formulario.montarEntrada({ ...base, tamanho: '' }, true)), ['tamanho']);
    for (const q of ['', '0', '-1', '1.5', 'abc', '2147483648']) assert.deepEqual(erros(formulario.montarEntrada({ ...base, quantidade: q }, true)), ['quantidade'], q);
    assert.deepEqual(erros(formulario.montarEntrada({ ...base, tamanho: 'x'.repeat(21) }, true)), ['tamanho']);
    assert.equal(formulario.montarEntrada({ ...base, quantidade: '2147483647' }, true).corpo.quantidade, 2147483647);
    assert.equal('empresaId' in formulario.montarEntrada(base, true).corpo, false);
  });

  test('fluxo.registrarEntrada: um único POST por chamada; recusa 4xx é confirmada; rede e 5xx não confirmadas; nunca repete sozinho', async () => {
    const { fluxo } = carregarMateriais();
    const corpo = { tamanho: '35', quantidade: 5, caNumero: '38271', caValidade: '2027-01-31' };
    servidor(resposta(201, { status: 'ok', repetida: false, operacao: { id: '1' }, lote: { loteId: 3, tamanho: '35', saldo: 5 } }));
    const ok = await fluxo.registrarEntrada(77, corpo);
    assert.deepEqual([ok.ok, ok.lote.loteId, chamadas.length], [true, 3, 1]);
    for (const [r, confirmado] of [[resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' }), true], [resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }), false], [new TypeError('Failed to fetch'), false]]) {
      servidor(r);
      const x = await fluxo.registrarEntrada(77, corpo);
      assert.deepEqual([x.ok, x.confirmado, chamadas.length], [false, confirmado, 1]);
    }
  });

  test('mensagens: sucesso com tamanho e quantidade; repetida sem duplicar; recusa e não confirmado distintos; nada do corpo vaza', () => {
    const { mensagens } = carregarMateriais();
    assert.equal(mensagens.resultadoEntrada({ ok: true }, { tamanho: '35', quantidade: 5 }, { nome: 'Botina' }), 'Entrada registrada em "Botina": 5 no tamanho 35.');
    assert.equal(mensagens.resultadoEntrada({ ok: true }, { quantidade: 8 }, {}), 'Entrada registrada: 8 (tamanho único).');
    assert.match(mensagens.resultadoEntrada({ ok: true, repetida: true }, {}, {}), /já estava registrada; nada foi duplicado/);
    assert.match(mensagens.resultadoEntrada({ ok: false, confirmado: true, resposta: { ok: false, status: 403 } }, {}, {}), /^Entrada não realizada: .*movimentar estoque/i);
    assert.match(mensagens.resultadoEntrada({ ok: false, confirmado: true, resposta: { ok: false, status: 409, codigo: 'MATERIAL_INATIVO' } }, {}, {}), /inativo/i);
    const incerta = mensagens.resultadoEntrada({ ok: false, confirmado: false, resposta: { ok: false, status: 0 } }, {}, {});
    assert.match(incerta, /^Entrada não confirmada: /);
    assert.match(incerta, /não duplica/);
    const v = mensagens.resultadoEntrada({ ok: false, confirmado: true, resposta: { ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ caminho: 'quantidade', valor: 'SEGREDO-9' }] } }, {}, {});
    assert.equal(/SEGREDO-9/.test(v), false);
  });
});

describe('entrada de estoque posterior — inspeção estática', () => {
  const html = ler('pages/materials.html');
  test('entrada e baixa no quadro Estoque por lote, ocultas até a permissão; tamanho sem seleção', () => {
    const quadro = html.slice(html.indexOf('<h2>Estoque por lote</h2>'), html.indexOf('<h2>Estoque mínimo por tamanho</h2>'));
    assert.match(quadro, /<div id="blocoEntradaEstoque" style="display:none[^"]*">/);
    assert.match(quadro, /<div id="blocoBaixaEstoque" style="display:none[^"]*">/);
    assert.match(quadro, /Registrar entrada de estoque/);
    assert.match(quadro, /<select id="entradaTamanho" class="select"><option value="">Selecione o tamanho<\/option><\/select>/);
    assert.match(quadro, /<input id="entradaQuantidade" class="input" type="number" min="1"/);
    assert.match(quadro, /<input id="entradaCa" class="input" type="text" maxlength="20"/);
    assert.match(quadro, /<button id="botaoRegistrarEntrada" class="filled-btn" type="button" disabled>/);
    assert.match(quadro, /<button id="botaoRegistrarBaixa" class="outlined-btn" type="button" disabled>/);
  });
});

describe('entrada de estoque posterior — página', () => {
  test('sem MOVIMENTAR_ESTOQUE: bloco oculto e nenhuma entrada possível', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_SEM_MOVIMENTAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.equal(pg.el('blocoEntradaEstoque').style.display, 'none');
    pg.preencher(ENTRADA_DOM);
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(escritas().length, 0);
  });

  test('com MOVIMENTAR_ESTOQUE: bloco visível; botão só com material escolhido; tamanhos sugeridos do tipo mais a lista padrão, começando sem seleção', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(pg.el('blocoEntradaEstoque').style.display, '');
    assert.equal(pg.el('botaoRegistrarEntrada').disabled, true);
    await escolherMaterial(pg);
    assert.equal(pg.el('botaoRegistrarEntrada').disabled, false);
    assert.match(pg.el('entradaTamanho').innerHTML, /^<option value="">Selecione o tamanho<\/option><option value="34">34<\/option><option value="35">35<\/option>/);
    assert.equal(/Único/.test(pg.el('entradaTamanho').innerHTML), false);
    assert.equal(pg.el('entradaTamanho').value, '');
  });

  test('tamanho que já tem lote, fora da lista padrão, também aparece', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], lotes: [lote({ tamanho: '45 largo' })] }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    assert.match(pg.el('entradaTamanho').innerHTML, /<option value="45 largo">45 largo<\/option>/);
  });

  test('entrada de 5 no tamanho 35: um POST na rota de entradas com CA, validade e chave, nenhum PATCH; estoque recarregado; mensagem; campos limpos', async () => {
    const estado = estadoPadrao({ materiais: [MATERIAL] });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    const antes = chamadas.length;
    estado.lotes = [lote({ loteId: 500, tamanho: '35', caNumero: '38271', caValidade: '2027-01-31', fisico: 5, disponivel: 5 })];
    pg.preencher(ENTRADA_DOM);
    await pg.disparar('botaoRegistrarEntrada');
    const depois = chamadas.slice(antes);
    const [envio, ...outras] = depois.filter((c) => c.metodo !== 'GET');
    assert.deepEqual([envio.metodo, envio.caminho, outras.length], ['POST', '/api/materiais/77/estoque/entradas', 0]);
    assert.deepEqual(semChave(envio.corpo), semChave({ tamanho: '35', quantidade: 5, caNumero: '38271', caValidade: '2027-01-31' }));
    assert.match(envio.corpo.chaveIdempotencia, UUID);
    assert.ok(depois.some((c) => c.metodo === 'GET' && c.caminho === '/api/materiais/77/estoque/lotes'), 'estoque recarregado');
    assert.match(pg.el('lotesCorpo').innerHTML, /<td>35<\/td>/);
    assert.match(pg.el('aviso').innerHTML, /Entrada registrada em &quot;Botina de segurança&quot;: 5 no tamanho 35/);
    assert.deepEqual(['entradaTamanho', 'entradaQuantidade', 'entradaCa', 'entradaCaValidade'].map((id) => pg.el(id).value), ['', '', '', '']);
    assert.equal(pg.el('gradeMaterial').value, '77', 'mesmo material selecionado');
  });

  test('sem tamanho, quantidade inválida, sem CA ou sem validade: nada é enviado e o campo é marcado', async () => {
    for (const [falta, id] of [[{ entradaTamanho: '' }, 'entradaTamanho'], [{ entradaQuantidade: '0' }, 'entradaQuantidade'], [{ entradaCa: '' }, 'entradaCa'], [{ entradaCaValidade: '' }, 'entradaCaValidade']]) {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
      const pg = montarPagina();
      await pg.esperar();
      await escolherMaterial(pg);
      pg.preencher({ ...ENTRADA_DOM, ...falta });
      await pg.disparar('botaoRegistrarEntrada');
      assert.equal(escritas().length, 0, id);
      assert.equal(pg.el(id).atributos['aria-invalid'], 'true', id);
    }
  });

  test('recusa 403 e 409 (inativo): mensagem de erro, campos preservados; rede: "não confirmada", um único POST, estoque recarregado para conferência', async () => {
    for (const [status, codigo, texto] of [[403, 'SEM_PERMISSAO', /movimentar estoque/i], [409, 'MATERIAL_INATIVO', /inativo/i]]) {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL], entrada: () => resposta(status, { status: 'erro', codigo }) }));
      const pg = montarPagina();
      await pg.esperar();
      await escolherMaterial(pg);
      pg.preencher(ENTRADA_DOM);
      await pg.disparar('botaoRegistrarEntrada');
      assert.match(pg.el('aviso').innerHTML, texto, String(status));
      assert.equal(pg.el('entradaQuantidade').value, '5', 'campos preservados');
    }
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], entrada: () => new TypeError('Failed to fetch') }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher(ENTRADA_DOM);
    const antes = chamadas.length;
    await pg.disparar('botaoRegistrarEntrada');
    const depois = chamadas.slice(antes);
    assert.equal(depois.filter((c) => c.metodo === 'POST').length, 1);
    assert.match(pg.el('aviso').innerHTML, /Entrada não confirmada/);
    assert.match(pg.el('aviso').innerHTML, /C07000/);
    assert.ok(depois.some((c) => c.caminho === '/api/materiais/77/estoque/lotes'), 'estoque recarregado para conferência');
    assert.equal(pg.el('entradaQuantidade').value, '5', 'campos preservados para repetir com a mesma chave');
  });

  test('401 na entrada devolve ao Portal', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], entrada: () => resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }) }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher(ENTRADA_DOM);
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('trocar de material limpa os campos da entrada e refaz a lista de tamanhos', async () => {
    const B = { ...MATERIAL, id: 88, nome: 'Luva B', tipo: 'Luva' };
    servidorRotas(estadoPadrao({ materiais: [MATERIAL, B] }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher(ENTRADA_DOM);
    await escolherMaterial(pg, 88);
    assert.deepEqual(['entradaTamanho', 'entradaQuantidade', 'entradaCa', 'entradaCaValidade'].map((id) => pg.el(id).value), ['', '', '', '']);
  });

  test('sessão encerrada durante a entrada: resposta posterior não é aplicada; blocos ocultos', async () => {
    const lenta = pendente();
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], entrada: () => lenta.promessa }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher(ENTRADA_DOM);
    const envio = pg.disparar('botaoRegistrarEntrada');
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();
    lenta.resolver(resposta(201, { status: 'ok', repetida: false, operacao: { id: '1' }, lote: { loteId: 9 } }));
    await envio;
    await pg.esperar();
    assert.equal(/Entrada registrada/.test(pg.el('aviso').innerHTML), false);
    assert.deepEqual([pg.el('blocoEntradaEstoque').style.display, pg.el('blocoBaixaEstoque').style.display], ['none', 'none']);
  });

  test('a entrada não interfere na edição cadastral: em modo edição, registrar entrada não envia PATCH nem sai da edição', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher(ENTRADA_DOM);
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(chamadas.some((c) => c.metodo === 'PATCH'), false);
    assert.equal(chamadas.filter((c) => /entradas$/.test(c.caminho)).length, 1);
    assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Estoque por lote na página de materiais
// ═══════════════════════════════════════════════════════════════════

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MOTIVOS = [['CA_VENCIDO', 'CA vencido'], ['AVARIA', 'Avaria'], ['DESCARTE', 'Descarte'], ['PERDA', 'Perda'],
  ['AJUSTE_INVENTARIO', 'Ajuste de inventário'], ['DEVOLUCAO_FORNECEDOR', 'Devolução ao fornecedor'], ['OUTRO', 'Outro']];
const lote = (extra) => ({
  loteId: 1, materialId: 77, tamanho: '40', caNumero: '12345', caValidade: '2027-12-31', origem: 'ENTRADA',
  quantidadeEntrada: 10, quantidadeBaixada: 0, quantidadeEntregue: 0, fisico: 10, bloqueado: 0, disponivel: 10, situacaoCa: 'VALIDO', ...extra,
});
const LOTES = [
  lote({ loteId: 1, tamanho: '40', caValidade: '2026-09-29', origem: 'SALDO_INICIAL', bloqueado: 10, disponivel: 0, situacaoCa: 'VENCIDO' }),
  lote({ loteId: 2, tamanho: '41', caNumero: '54321', caValidade: '2026-10-20', quantidadeEntrada: 20, fisico: 20, disponivel: 20, situacaoCa: 'A_VENCER' }),
  lote({ loteId: 3, tamanho: null, caNumero: null, caValidade: null, origem: 'SALDO_INICIAL', quantidadeEntrada: 5, fisico: 5, bloqueado: 5, disponivel: 0, situacaoCa: 'SEM_CA' }),
];
const PODE_EDITAR = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { ENTRADA_ESTOQUE: true, BAIXA_ESTOQUE: true }, administracao: {} };
const escritas = () => chamadas.filter((c) => c.metodo !== 'GET');
const semChave = (corpo) => ({ ...corpo, chaveIdempotencia: undefined });

describe('cadastro do material: prazo de uso e controle de tamanho obrigatórios', () => {
  const base = (extra = {}) => ({
    nome: 'Botina', categoria: 'EPI', tipo: 'Botina de Segurança', tipoCustom: '', fabricante: '', codigoInterno: '', unidade: 'Par', estoqueMinimo: '5',
    prazoUnidade: 'meses', prazo: '6', controleTamanho: 'grade', descricao: '', registrarEntrada: 'nao', quantidadeComprada: '', tamanhoEntrada: '',
    caEntrada: '', caValidadeEntrada: '', ...extra,
  });

  test('sem prazo, com prazo zero ou negativo: erro no campo prazo; o antigo "sem prazo definido" não apaga o prazo', () => {
    const { formulario } = carregarMateriais();
    for (const prazo of ['', '0', '-3']) {
      const r = formulario.montarCorpo(base({ prazo }));
      assert.equal(r.ok, false, prazo);
      assert.ok(r.erros.some((e) => e.campo === 'prazo'), prazo);
    }
    assert.equal(formulario.montarCorpo(base({ definePrazo: 'nao' })).corpo.prazoUsoDias, 180);
  });

  test('controle de tamanho obrigatório: tamanho único envia exigeTamanho false; possui tamanhos envia true', () => {
    const { formulario } = carregarMateriais();
    assert.ok(formulario.montarCorpo(base({ controleTamanho: '' })).erros.some((e) => e.campo === 'controleTamanho'));
    assert.equal(formulario.montarCorpo(base({ controleTamanho: 'unico' })).corpo.exigeTamanho, false);
    assert.equal(formulario.montarCorpo(base({ controleTamanho: 'grade' })).corpo.exigeTamanho, true);
    assert.deepEqual({ ...formulario.CONTROLES_TAMANHO }, { unico: false, grade: true });
  });

  test('o cadastro do material não leva CA nem validade: eles pertencem à entrada', () => {
    const { formulario } = carregarMateriais();
    const r = formulario.montarCorpo(base({ caNumero: '38271', caValidade: '2027-01-31' }));
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.corpo).sort(), ['categoria', 'estoqueMinimo', 'exigeTamanho', 'nome', 'prazoUsoDias', 'tipo', 'unidade']);
  });

  test('entrada inicial: quantidade, CA e validade obrigatórios; tamanho só quando o material possui tamanhos', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.montarCorpo(base({ registrarEntrada: 'sim' })).erros.map((e) => e.campo).sort(),
      ['caEntrada', 'caValidadeEntrada', 'quantidadeComprada', 'tamanhoEntrada']);
    const completa = { registrarEntrada: 'sim', quantidadeComprada: '12', tamanhoEntrada: '42', caEntrada: ' 38271 ', caValidadeEntrada: '2027-01-31' };
    assert.deepEqual(formulario.montarCorpo(base({ ...completa, controleTamanho: 'unico' })).entrada, { quantidade: 12, caNumero: '38271', caValidade: '2027-01-31' });
    assert.deepEqual(formulario.montarCorpo(base(completa)).entrada, { tamanho: '42', quantidade: 12, caNumero: '38271', caValidade: '2027-01-31' });
    assert.equal(formulario.montarCorpo(base({ quantidadeComprada: '12' })).entrada, null);
  });

  test('a lista de tamanhos não oferece "Único": material sem tamanho não escolhe tamanho', () => {
    const { formulario } = carregarMateriais();
    assert.equal(formulario.TAMANHOS_GRADE.includes('Único'), false);
    assert.deepEqual(formulario.tamanhosSugeridos('Óculos de proteção'), []);
    assert.deepEqual(formulario.tamanhosDaEntrada([lote({ tamanho: '45 largo' }), lote({ tamanho: null })], 'Luva').slice(0, 3), ['45 largo', 'PP', 'P']);
  });
});

describe('edição do material: prazo e controle de tamanho', () => {
  const original = { ...MATERIAL, prazoUsoDias: 180, exigeTamanho: null, caNumero: '38271', caValidade: '2027-01-31' };
  const camposDe = (m) => carregarMateriais().formulario.camposDoMaterial(m).campos;

  test('o prazo atual aparece e a classificação aparece; legado sem classificação aparece vazio; CA mestre fora do formulário', () => {
    const c = camposDe(original);
    assert.deepEqual([c.prazo, c.prazoUnidade, c.controleTamanho], ['6', 'meses', '']);
    assert.equal(camposDe({ ...original, exigeTamanho: true }).controleTamanho, 'grade');
    assert.equal(camposDe({ ...original, exigeTamanho: false }).controleTamanho, 'unico');
    assert.equal('caNumero' in c || 'caValidade' in c || 'definePrazo' in c, false);
  });

  test('prazo para mais ou para menos envia prazoUsoDias; apagar ou zerar é erro', () => {
    const { formulario } = carregarMateriais();
    for (const [prazo, dias] of [['8', 240], ['3', 90]]) {
      assert.deepEqual(formulario.montarEdicao({ ...camposDe(original), prazo }, original).corpo, { prazoUsoDias: dias });
    }
    for (const prazo of ['', '0']) {
      assert.ok(formulario.montarEdicao({ ...camposDe(original), prazo }, original).erros.some((e) => e.campo === 'prazo'), prazo);
    }
  });

  test('legado sem prazo continua editável sem informar prazo; ao informar, passa a ter', () => {
    const { formulario } = carregarMateriais();
    const legado = { ...original, prazoUsoDias: null };
    assert.deepEqual(formulario.montarEdicao({ ...camposDe(legado), nome: 'Botina nova' }, legado).corpo, { nome: 'Botina nova' });
    assert.deepEqual(formulario.montarEdicao({ ...camposDe(legado), prazo: '1', prazoUnidade: 'anos' }, legado).corpo, { prazoUsoDias: 365 });
  });

  test('primeira classificação do legado envia exigeTamanho; sem escolha nada é enviado; classificado não volta a vazio', () => {
    const { formulario } = carregarMateriais();
    assert.equal(formulario.montarEdicao(camposDe(original), original).alterado, false);
    assert.deepEqual(formulario.montarEdicao({ ...camposDe(original), controleTamanho: 'unico' }, original).corpo, { exigeTamanho: false });
    const classificado = { ...original, exigeTamanho: true };
    assert.deepEqual(formulario.montarEdicao({ ...camposDe(classificado), controleTamanho: 'unico' }, classificado).corpo, { exigeTamanho: false });
    assert.ok(formulario.montarEdicao({ ...camposDe(classificado), controleTamanho: '' }, classificado).erros.some((e) => e.campo === 'controleTamanho'));
  });

  test('o CA mestre do legado nunca é enviado nem apagado pela edição', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.montarEdicao({ ...camposDe(original), nome: 'Outro nome' }, original).corpo, { nome: 'Outro nome' });
  });

  test('409 de saldo incompatível vira mensagem clara', () => {
    const texto = carregarMateriais().mensagens.erroEdicao({ ok: false, status: 409, codigo: 'MATERIAL_TAMANHO_SALDO_INCOMPATIVEL' });
    assert.match(texto, /controle de tamanho/i);
    assert.match(texto, /saldo/i);
  });
});

describe('entrada de estoque por lote: CA e validade sempre; tamanho conforme o material', () => {
  const campos = (extra = {}) => ({ tamanho: '42', quantidade: '10', caNumero: ' 38271 ', caValidade: '2027-01-31', ...extra });

  test('CA, validade e quantidade são obrigatórios; motivo não existe na entrada', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.montarEntrada({ tamanho: '42' }, true).erros.map((e) => e.campo).sort(), ['caNumero', 'caValidade', 'quantidade']);
    assert.deepEqual(formulario.montarEntrada(campos({ motivo: 'Compra NF 1' }), true).corpo, { tamanho: '42', quantidade: 10, caNumero: '38271', caValidade: '2027-01-31' });
    assert.ok(formulario.montarEntrada(campos({ caValidade: '31/01/2027' }), true).erros.some((e) => e.campo === 'caValidade'));
  });

  test('possui tamanhos: tamanho obrigatório; tamanho único: tamanho não é enviado; não classificado: não registra', () => {
    const { formulario } = carregarMateriais();
    assert.ok(formulario.montarEntrada(campos({ tamanho: '' }), true).erros.some((e) => e.campo === 'tamanho'));
    assert.deepEqual(formulario.montarEntrada(campos(), false).corpo, { quantidade: 10, caNumero: '38271', caValidade: '2027-01-31' });
    const semClasse = formulario.montarEntrada(campos(), null);
    assert.equal(semClasse.ok, false);
    assert.match(semClasse.erros[0].mensagem, /controle de tamanho/i);
  });

  test('mensagens do servidor: CA vencido, tamanho, material não classificado e inativo', () => {
    const { mensagens } = carregarMateriais();
    const validacao = (codigo) => ({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.x', codigo }] });
    assert.match(mensagens.erroEntrada(validacao('CA_VENCIDO')), /CA vencido/i);
    assert.match(mensagens.erroEntrada(validacao('TAMANHO_OBRIGATORIO')), /tamanho/i);
    assert.match(mensagens.erroEntrada(validacao('TAMANHO_NAO_SE_APLICA')), /tamanho único/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 409, codigo: 'MATERIAL_TAMANHO_NAO_CLASSIFICADO' }), /controle de tamanho/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 409, codigo: 'MATERIAL_INATIVO' }), /inativo/i);
  });
});

describe('idempotência das operações de estoque', () => {
  const corpo = { tamanho: '42', quantidade: 10, caNumero: '38271', caValidade: '2027-01-31' };
  const loteCriado = (loteId) => resposta(201, { status: 'ok', repetida: false, operacao: { id: '1', tipo: 'ENTRADA', loteId }, lote: { loteId, tamanho: '42', saldo: 10 } });

  test('a mesma operação usa a mesma chave até o sucesso; conteúdo ou alvo novo, chave nova; depois do sucesso, chave nova', () => {
    let n = 0;
    const op = carregarMateriais().idempotencia.criar(() => `chave-${n += 1}`);
    const a = op.chave(77, corpo);
    assert.equal(op.chave(77, { ...corpo }), a);
    const b = op.chave(77, { ...corpo, quantidade: 11 });
    assert.notEqual(b, a);
    assert.notEqual(op.chave(78, { ...corpo, quantidade: 11 }), b);
    const c = op.chave(78, { ...corpo, quantidade: 11 });
    op.concluir();
    assert.notEqual(op.chave(78, { ...corpo, quantidade: 11 }), c);
  });

  test('sem gerador próprio, a chave é um UUID do crypto.randomUUID', () => {
    assert.match(carregarMateriais().idempotencia.criar().chave(1, {}), UUID);
  });

  test('fluxo.registrarEntrada: rota de entradas com a chave; repetição depois de falha de rede usa a mesma chave; sucesso conclui', async () => {
    const M = carregarMateriais();
    assert.equal(M.acoes.movimentar, undefined);
    assert.equal(M.acoes.estoque, undefined);
    const op = M.idempotencia.criar();
    servidor(new TypeError('Failed to fetch'), loteCriado(9));
    const r1 = await M.fluxo.registrarEntrada(77, corpo, op);
    assert.deepEqual([r1.ok, r1.confirmado], [false, false]);
    const r2 = await M.fluxo.registrarEntrada(77, corpo, op);
    assert.deepEqual([r2.ok, r2.lote.loteId], [true, 9]);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais/77/estoque/entradas', 'POST /api/materiais/77/estoque/entradas']);
    assert.match(chamadas[0].corpo.chaveIdempotencia, UUID);
    assert.equal(chamadas[1].corpo.chaveIdempotencia, chamadas[0].corpo.chaveIdempotencia);
    assert.deepEqual(semChave(chamadas[0].corpo), semChave(corpo));
    const usada = chamadas[1].corpo.chaveIdempotencia;
    servidor(loteCriado(10));
    await M.fluxo.registrarEntrada(77, corpo, op);
    assert.notEqual(chamadas[0].corpo.chaveIdempotencia, usada, 'nova entrada igual, depois do sucesso, é outra operação');
  });

  test('cadastro com entrada inicial: POST do material e depois a entrada com chave; sem permissão, nenhuma entrada', async () => {
    const M = carregarMateriais();
    const entrada = { quantidade: 12, caNumero: '38271', caValidade: '2027-01-31' };
    servidor(resposta(201, { status: 'ok', material: { ...MATERIAL, id: 88 } }), loteCriado(3));
    const r = await M.fluxo.cadastrar({ corpo: { nome: 'Óculos', exigeTamanho: false, prazoUsoDias: 180 }, entrada, podeMovimentar: true, idempotencia: M.idempotencia.criar() });
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais', 'POST /api/materiais/88/estoque/entradas']);
    assert.deepEqual(semChave(chamadas[1].corpo), semChave(entrada));
    assert.match(chamadas[1].corpo.chaveIdempotencia, UUID);
    assert.deepEqual([r.ok, r.entrada.solicitada, r.entrada.realizada], [true, true, true]);

    servidor(resposta(201, { status: 'ok', material: { ...MATERIAL, id: 89 } }));
    const semPermissao = await M.fluxo.cadastrar({ corpo: { nome: 'Óculos' }, entrada, podeMovimentar: false, idempotencia: M.idempotencia.criar() });
    assert.deepEqual([chamadas.length, semPermissao.entrada.motivo], [1, 'SEM_PERMISSAO']);
  });

  test('entrada inicial não confirmada: repetir a mesma entrada depois usa a mesma chave', async () => {
    const M = carregarMateriais();
    const op = M.idempotencia.criar();
    const entrada = { quantidade: 12, caNumero: '38271', caValidade: '2027-01-31' };
    servidor(resposta(201, { status: 'ok', material: { ...MATERIAL, id: 90 } }), new TypeError('Failed to fetch'));
    const r = await M.fluxo.cadastrar({ corpo: { nome: 'Óculos' }, entrada, podeMovimentar: true, idempotencia: op });
    assert.equal(r.entrada.motivo, 'NAO_CONFIRMADO');
    const chave = chamadas[1].corpo.chaveIdempotencia;
    servidor(loteCriado(4));
    await M.fluxo.registrarEntrada(90, entrada, op);
    assert.equal(chamadas[0].corpo.chaveIdempotencia, chave);
  });
});

describe('estoque do material: lotes com físico, bloqueado e disponível', () => {
  test('carregarEstoque usa a consulta de lotes e devolve lotes e totais', async () => {
    const M = carregarMateriais();
    servidor(resposta(200, { status: 'ok', material: MATERIAL, lotes: LOTES, totais: { fisico: 35, bloqueado: 15, disponivel: 20 } }));
    const r = await M.fluxo.carregarEstoque(77);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['GET /api/materiais/77/estoque/lotes']);
    assert.deepEqual([r.ok, r.totais, r.lotes.length, r.material.id], [true, { fisico: 35, bloqueado: 15, disponivel: 20 }, 3, 77]);
  });

  test('linhas dos lotes: tamanho nulo aparece como Único; situação amigável; vencido bloqueado; a vencer disponível; tudo escapado', () => {
    const { estoque } = carregarMateriais();
    const linhas = estoque.linhasLotes(LOTES).split('</tr>').filter(Boolean);
    assert.equal(linhas.length, 3);
    assert.match(linhas[0], /<td>40<\/td>/);
    assert.match(linhas[0], /29\/09\/2026/);
    assert.match(linhas[0], /badge badge-danger">Vencido</);
    assert.match(linhas[0], />10<\/td><td[^>]*>10<\/td><td[^>]*>0<\/td>/, 'físico 10, bloqueado 10, disponível 0');
    assert.match(linhas[1], /badge badge-warning">A vencer</);
    assert.match(linhas[1], />20<\/td><td[^>]*>0<\/td><td[^>]*>20<\/td>/, 'a vencer continua disponível');
    assert.match(linhas[2], /<td>Único<\/td>/);
    assert.match(linhas[2], /Sem CA/);
    assert.equal(LOTES[2].tamanho, null, 'o valor recebido do backend não muda');
    assert.equal(estoque.linhasLotes([lote({ caNumero: '<b>x</b>' })]).includes('<b>'), false);
  });

  test('situações: válido, vence hoje e a vencer não bloqueiam; vencido e sem CA bloqueiam', () => {
    const { estoque } = carregarMateriais();
    assert.deepEqual(['VALIDO', 'VENCE_HOJE', 'A_VENCER', 'VENCIDO', 'SEM_CA'].map((s) => [estoque.rotuloSituacao(s), estoque.classeSituacao(s)]), [
      ['Válido', 'badge-ok'], ['Vence hoje', 'badge-warning'], ['A vencer', 'badge-warning'], ['Vencido', 'badge-danger'], ['Sem CA (legado)', 'badge-danger'],
    ]);
    assert.deepEqual([estoque.rotuloTamanho(null), estoque.rotuloTamanho('42')], ['Único', '42']);
  });

  test('opções da baixa: um lote por opção, identificado por tamanho, CA e validade; começa sem seleção', () => {
    const html = carregarMateriais().estoque.opcoesLotes(LOTES);
    assert.match(html, /^<option value="">Selecione o lote<\/option>/);
    assert.match(html, /<option value="2">41 · CA 54321 · val\. 20\/10\/2026 · físico 20<\/option>/);
    assert.match(html, /<option value="3">Único · sem CA · físico 5<\/option>/);
  });
});

describe('baixa manual por lote', () => {
  const baixa = (extra = {}) => carregarMateriais().formulario.montarBaixa({ loteId: '2', quantidade: '4', motivo: 'AVARIA', justificativa: '', ...extra }, LOTES);

  test('motivos exatos da baixa, com rótulos amigáveis', () => {
    assert.deepEqual(carregarMateriais().formulario.MOTIVOS_BAIXA.map((m) => [m.codigo, m.rotulo]), MOTIVOS);
  });

  test('lote e motivo obrigatórios; quantidade até o físico do lote; Outro exige justificativa', () => {
    assert.deepEqual([baixa().loteId, baixa().corpo], [2, { quantidade: 4, motivo: 'AVARIA' }]);
    for (const [extra, campo] of [[{ loteId: '' }, 'lote'], [{ quantidade: '21' }, 'quantidade'], [{ quantidade: '0' }, 'quantidade'], [{ motivo: '' }, 'motivo'], [{ motivo: 'OUTRO' }, 'justificativa']]) {
      const r = baixa(extra);
      assert.equal(r.ok, false, JSON.stringify(extra));
      assert.ok(r.erros.some((e) => e.campo === campo), JSON.stringify(extra));
    }
    assert.deepEqual(baixa({ motivo: 'OUTRO', justificativa: '  Doação  ' }).corpo, { quantidade: 4, motivo: 'OUTRO', justificativa: 'Doação' });
  });

  test('fluxo.registrarBaixa: POST no lote escolhido com a chave; repetição inconclusiva usa a mesma chave', async () => {
    const M = carregarMateriais();
    const op = M.idempotencia.criar();
    servidor(resposta(503, { status: 'error', codigo: 'INDISPONIVEL' }), resposta(201, { status: 'ok', repetida: false, operacao: { id: '5', tipo: 'BAIXA', loteId: 2 }, lote: { loteId: 2, saldo: 16 } }));
    const r1 = await M.fluxo.registrarBaixa(2, { quantidade: 4, motivo: 'AVARIA' }, op);
    const r2 = await M.fluxo.registrarBaixa(2, { quantidade: 4, motivo: 'AVARIA' }, op);
    assert.deepEqual([r1.ok, r1.confirmado, r2.ok], [false, false, true]);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/estoque/lotes/2/baixas', 'POST /api/estoque/lotes/2/baixas']);
    assert.match(chamadas[0].corpo.chaveIdempotencia, UUID);
    assert.equal(chamadas[1].corpo.chaveIdempotencia, chamadas[0].corpo.chaveIdempotencia);
  });

  test('mensagens: saldo insuficiente, lote não encontrado e justificativa', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroBaixa({ ok: false, status: 409, codigo: 'SALDO_LOTE_INSUFICIENTE' }), /saldo/i);
    assert.match(mensagens.erroBaixa({ ok: false, status: 404, codigo: 'LOTE_NAO_ENCONTRADO' }), /lote/i);
    assert.match(mensagens.erroBaixa({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.justificativa', codigo: 'JUSTIFICATIVA_OBRIGATORIA' }] }), /justificativa/i);
  });
});

describe('tela de materiais com estoque por lote: inspeção estática', () => {
  const html = ler('pages/materials.html');
  const codigo = semComentarios(html);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

  test('cadastro: prazo e controle de tamanho obrigatórios; sem "Define prazo" e sem CA no cadastro do material', () => {
    assert.equal(/Define prazo/.test(html), false);
    for (const id of ['materialValidade', 'materialCa', 'materialCaValidade']) assert.equal(ids.includes(id), false, `#${id} saiu`);
    assert.match(html, /<label for="materialPrazo" id="materialPrazoLabel">Prazo de uso \(meses\) \*<\/label>/);
    assert.match(html, /<label for="materialControleTamanho">Controle de tamanho \*<\/label>/);
    assert.match(html, /<option value="unico">Tamanho único<\/option>/);
    assert.match(html, /<option value="grade">Possui tamanhos<\/option>/);
    for (const id of ['materialEntradaCa', 'materialEntradaCaValidade', 'campoTamanhoEntrada', 'campoTamanhoEntradaUnico']) assert.ok(ids.includes(id), `falta #${id}`);
  });

  test('entrada: sem motivo, com CA e validade obrigatórios e sem "quando houver"', () => {
    assert.equal(ids.includes('entradaMotivo'), false);
    assert.equal(/Motivo \(opcional\)/.test(html), false);
    assert.equal(/quando houver/i.test(html), false);
    assert.match(html, /<label for="entradaCa">Número do CA \*<\/label>/);
    assert.match(html, /<label for="entradaCaValidade">Validade do CA \*<\/label>/);
    assert.match(html, /<input id="entradaCaValidade" class="input" type="date"/);
    for (const id of ['campoEntradaTamanho', 'entradaTamanho', 'entradaTamanhoUnico']) assert.ok(ids.includes(id), `falta #${id}`);
  });

  test('saldos e lotes: físico, bloqueado e disponível à vista; tabela de lotes; a grade antiga de chips saiu', () => {
    for (const id of ['saldoFisico', 'saldoBloqueado', 'saldoDisponivel', 'lotesCorpo']) assert.ok(ids.includes(id), `falta #${id}`);
    for (const rotulo of ['Físico', 'Bloqueado', 'Disponível']) assert.ok(html.includes(rotulo), rotulo);
    assert.equal(ids.includes('sizeChipsGrid'), false);
  });

  test('baixa: lote, quantidade, motivos iguais aos do módulo e justificativa', () => {
    for (const id of ['blocoBaixaEstoque', 'baixaLote', 'baixaQuantidade', 'baixaMotivo', 'campoBaixaJustificativa', 'baixaJustificativa', 'botaoRegistrarBaixa']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    const trecho = html.slice(html.indexOf('id="baixaMotivo"')).split('</select>')[0];
    assert.deepEqual([...trecho.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]), [['', 'Selecione o motivo'], ...MOTIVOS]);
  });

  test('a página e o módulo não usam mais a movimentação antiga nem a consulta de estoque por tamanho', () => {
    const js = semComentarios(ler('js/materiais.js'));
    for (const fonte of [codigo, js]) {
      assert.equal(/estoque\/movimentar|\.movimentar\(|movimentar:/.test(fonte), false);
      assert.equal(/'\/estoque'/.test(fonte), false);
    }
    assert.match(js, /\/estoque\/entradas/);
    assert.match(js, /\/estoque\/lotes/);
    assert.match(js, /\/baixas/);
  });
});

describe('página: cadastro com prazo, controle de tamanho e entrada inicial por lote', () => {
  const DOM = (extra = {}) => ({
    materialNome: 'Óculos incolor', materialCategoria: 'EPI', materialTipo: 'Óculos de Proteção Incolor', materialUnidade: 'Unidade', materialEstoqueMinimo: '5',
    materialValidadeTipo: 'meses', materialPrazo: '6', materialControleTamanho: 'unico', materialRegistrarEntrada: 'nao', ...extra,
  });

  test('sem prazo ou sem controle de tamanho: nada é enviado e o campo é marcado', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    for (const [extra, id] of [[{ materialPrazo: '' }, 'materialPrazo'], [{ materialControleTamanho: '' }, 'materialControleTamanho']]) {
      pg.preencher(DOM(extra));
      await pg.disparar('botaoSalvar');
      assert.equal(escritas().length, 0);
      assert.equal(pg.el(id).atributos['aria-invalid'], 'true');
    }
  });

  test('tamanho único com entrada inicial: material com exigeTamanho false e sem CA; entrada no endpoint novo, sem tamanho e com chave', async () => {
    servidorRotas(estadoPadrao({ proximoId: 88 }));
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(DOM({ materialRegistrarEntrada: 'sim' }));
    await pg.disparar('materialRegistrarEntrada', 'change');
    await pg.disparar('materialControleTamanho', 'change');
    assert.deepEqual([pg.el('campoTamanhoEntrada').style.display, pg.el('campoTamanhoEntradaUnico').style.display], ['none', '']);
    pg.preencher({ materialQuantidadeComprada: '12', materialEntradaCa: '38271', materialEntradaCaValidade: '2027-01-31' });
    await pg.disparar('botaoSalvar');
    const [material, entrada, ...resto] = escritas();
    assert.deepEqual([material.caminho, entrada.caminho, resto.length], ['/api/materiais', '/api/materiais/88/estoque/entradas', 0]);
    assert.deepEqual([material.corpo.exigeTamanho, material.corpo.prazoUsoDias, 'caNumero' in material.corpo], [false, 180, false]);
    assert.deepEqual(semChave(entrada.corpo), semChave({ quantidade: 12, caNumero: '38271', caValidade: '2027-01-31' }));
    assert.match(entrada.corpo.chaveIdempotencia, UUID);
    assert.match(pg.el('aviso').innerHTML, /Material cadastrado com sucesso/);
    assert.match(pg.el('aviso').innerHTML, /tamanho único/i);
  });

  test('possui tamanhos com entrada inicial: sem tamanho nada é enviado; com tamanho, a entrada leva o tamanho', async () => {
    servidorRotas(estadoPadrao({ proximoId: 89 }));
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(DOM({ materialNome: 'Botina', materialTipo: 'Botina de Segurança', materialControleTamanho: 'grade', materialRegistrarEntrada: 'sim', materialQuantidadeComprada: '10', materialEntradaCa: '1', materialEntradaCaValidade: '2027-01-31' }));
    await pg.disparar('materialRegistrarEntrada', 'change');
    await pg.disparar('materialControleTamanho', 'change');
    assert.deepEqual([pg.el('campoTamanhoEntrada').style.display, pg.el('campoTamanhoEntradaUnico').style.display], ['', 'none']);
    await pg.disparar('botaoSalvar');
    assert.equal(escritas().length, 0);
    assert.equal(pg.el('materialTamanhoEntrada').atributos['aria-invalid'], 'true');
    pg.preencher({ materialTamanhoEntrada: '42' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(escritas().map((c) => [c.caminho, c.corpo.tamanho]), [['/api/materiais', undefined], ['/api/materiais/89/estoque/entradas', '42']]);
  });

  test('entrada inicial recusada: o material fica cadastrado e a mensagem diz que a entrada falhou, sem dizer que o estoque foi registrado', async () => {
    servidorRotas(estadoPadrao({ proximoId: 90, entrada: () => resposta(400, { status: 'error', codigo: 'VALIDACAO', detalhes: [{ campo: 'body.caValidade', codigo: 'CA_VENCIDO' }] }) }));
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(DOM({ materialRegistrarEntrada: 'sim', materialQuantidadeComprada: '12', materialEntradaCa: '1', materialEntradaCaValidade: '2020-01-31' }));
    await pg.disparar('botaoSalvar');
    const aviso = pg.el('aviso').innerHTML;
    assert.match(aviso, /Material cadastrado com sucesso/);
    assert.match(aviso, /Entrada inicial não realizada/);
    assert.match(aviso, /CA vencido/i);
    assert.equal(/Entrada inicial registrada/.test(aviso), false);
    assert.equal(pg.el('gradeMaterial').value, '90', 'o material criado fica selecionado');
  });

  test('entrada inicial não confirmada: os dados ficam na entrada do material, e repetir usa a mesma chave', async () => {
    let n = 0;
    const estado = estadoPadrao({ proximoId: 91, materialEstoque: { exigeTamanho: false } });
    const original = estado.entrada;
    estado.entrada = (id, corpo) => { n += 1; return n === 1 ? new TypeError('Failed to fetch') : original(id, corpo); };
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(DOM({ materialRegistrarEntrada: 'sim', materialQuantidadeComprada: '12', materialEntradaCa: '38271', materialEntradaCaValidade: '2027-01-31' }));
    await pg.disparar('botaoSalvar');
    assert.match(pg.el('aviso').innerHTML, /não confirmada/);
    assert.deepEqual([pg.el('gradeMaterial').value, pg.el('entradaQuantidade').value, pg.el('entradaCa').value, pg.el('entradaCaValidade').value], ['91', '12', '38271', '2027-01-31']);
    await pg.disparar('botaoRegistrarEntrada');
    const entradas = escritas().filter((c) => /entradas$/.test(c.caminho));
    assert.equal(entradas.length, 2);
    assert.equal(entradas[1].corpo.chaveIdempotencia, entradas[0].corpo.chaveIdempotencia);
  });
});

describe('página: edição com prazo e controle de tamanho', () => {
  test('legado sem classificação: prazo atual aparece, controle vazio; a primeira classificação envia só exigeTamanho', async () => {
    const estado = estadoPadrao({ materiais: [MATERIAL], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL, id, exigeTamanho: null } }) });
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await pg.disparar('botaoEditarMaterial');
    assert.deepEqual([pg.el('materialPrazo').value, pg.el('materialValidadeTipo').value, pg.el('materialControleTamanho').value], ['6', 'meses', '']);
    pg.el('materialControleTamanho').value = 'grade';
    await pg.disparar('botaoSalvar');
    assert.deepEqual(escritas().map((c) => [c.metodo, c.caminho, c.corpo]), [['PATCH', '/api/materiais/77', { exigeTamanho: true }]]);
  });

  test('mudança recusada por saldo incompatível: mensagem clara e a edição continua aberta', async () => {
    const estado = estadoPadrao({
      materiais: [MATERIAL],
      buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL, id, exigeTamanho: true } }),
      alterar: () => resposta(409, { status: 'error', codigo: 'MATERIAL_TAMANHO_SALDO_INCOMPATIVEL', message: 'x' }),
    });
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await pg.disparar('botaoEditarMaterial');
    assert.equal(pg.el('materialControleTamanho').value, 'grade');
    pg.el('materialControleTamanho').value = 'unico';
    await pg.disparar('botaoSalvar');
    assert.match(pg.el('aviso').innerHTML, /controle de tamanho/i);
    assert.match(pg.el('aviso').innerHTML, /saldo/i);
    assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
  });
});

describe('página: estoque por lote, entrada e baixa', () => {
  test('ao escolher o material: consulta de lotes; físico, bloqueado e disponível à vista; Único e situações na tabela; nenhuma consulta antiga', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], lotes: LOTES, materialEstoque: { exigeTamanho: true } }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    assert.ok(chamadas.some((c) => c.metodo === 'GET' && c.caminho === '/api/materiais/77/estoque/lotes'));
    assert.equal(chamadas.some((c) => c.caminho === '/api/materiais/77/estoque'), false);
    assert.deepEqual([pg.el('saldoFisico').textContent, pg.el('saldoBloqueado').textContent, pg.el('saldoDisponivel').textContent], ['35', '15', '20']);
    for (const texto of [/Único/, /Vencido/, /A vencer/, /Sem CA/]) assert.match(pg.el('lotesCorpo').innerHTML, texto);
    assert.match(pg.el('baixaLote').innerHTML, /<option value="2">/);
  });

  test('material com tamanhos: a entrada pede tamanho; sem tamanho nada é enviado', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], materialEstoque: { exigeTamanho: true } }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    assert.deepEqual([pg.el('campoEntradaTamanho').style.display, pg.el('entradaTamanhoUnico').style.display], ['', 'none']);
    pg.preencher({ entradaTamanho: '', entradaQuantidade: '5', entradaCa: '1', entradaCaValidade: '2027-01-31' });
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(escritas().length, 0);
    assert.equal(pg.el('entradaTamanho').atributos['aria-invalid'], 'true');
  });

  test('tamanho único: sem campo de tamanho, "Tamanho: Único"; a entrada vai sem tamanho e o sucesso atualiza lotes e saldos', async () => {
    const estado = estadoPadrao({ materiais: [MATERIAL], materialEstoque: { exigeTamanho: false } });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    assert.deepEqual([pg.el('campoEntradaTamanho').style.display, pg.el('entradaTamanhoUnico').style.display], ['none', '']);
    assert.match(pg.el('entradaTamanhoUnico').textContent, /Tamanho: Único/);
    pg.preencher({ entradaQuantidade: '8', entradaCa: '38271', entradaCaValidade: '2027-01-31' });
    estado.lotes = [lote({ loteId: 500, tamanho: null, caNumero: '38271', caValidade: '2027-01-31', fisico: 8, disponivel: 8 })];
    await pg.disparar('botaoRegistrarEntrada');
    const [entrada, ...resto] = escritas();
    assert.deepEqual([entrada.caminho, resto.length, 'tamanho' in entrada.corpo], ['/api/materiais/77/estoque/entradas', 0, false]);
    assert.equal(pg.el('saldoDisponivel').textContent, '8');
    assert.match(pg.el('aviso').innerHTML, /Entrada registrada/);
    assert.deepEqual([pg.el('entradaQuantidade').value, pg.el('entradaCa').value, pg.el('entradaCaValidade').value], ['', '', '']);
  });

  test('material não classificado: a entrada fica bloqueada com a orientação de classificar', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], materialEstoque: { exigeTamanho: null } }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    assert.equal(pg.el('botaoRegistrarEntrada').disabled, true);
    assert.match(pg.el('entradaEstoqueHelper').textContent, /controle de tamanho/i);
  });

  test('idempotência na tela: a repetição depois de falha usa a mesma chave; conteúdo alterado, chave nova; duplo clique envia uma vez', async () => {
    let n = 0;
    const estado = estadoPadrao({ materiais: [MATERIAL], materialEstoque: { exigeTamanho: false } });
    const original = estado.entrada;
    estado.entrada = (id, corpo) => { n += 1; return n <= 2 ? new TypeError('Failed to fetch') : original(id, corpo); };
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaQuantidade: '8', entradaCa: '38271', entradaCaValidade: '2027-01-31' });
    await pg.disparar('botaoRegistrarEntrada');
    await pg.disparar('botaoRegistrarEntrada');
    pg.preencher({ entradaQuantidade: '9' });
    await Promise.all([pg.disparar('botaoRegistrarEntrada'), pg.disparar('botaoRegistrarEntrada')]);
    const chaves = escritas().map((c) => c.corpo.chaveIdempotencia);
    assert.equal(chaves.length, 3, 'o duplo clique enviou uma vez só');
    assert.equal(chaves[1], chaves[0], 'mesma entrada depois de falha: mesma chave');
    assert.notEqual(chaves[2], chaves[0], 'quantidade alterada: outra operação');
  });

  test('baixa: lote escolhido, quantidade limitada ao físico, Outro exige justificativa; POST no lote certo e saldos atualizados', async () => {
    const estado = estadoPadrao({ materiais: [MATERIAL], lotes: LOTES, materialEstoque: { exigeTamanho: true } });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.el('baixaLote').value = '2';
    await pg.disparar('baixaLote', 'change');
    assert.equal(pg.el('baixaQuantidade').max, '20');
    pg.preencher({ baixaQuantidade: '21', baixaMotivo: 'AVARIA' });
    await pg.disparar('botaoRegistrarBaixa');
    assert.equal(escritas().length, 0, 'acima do físico do lote');
    pg.preencher({ baixaQuantidade: '4', baixaMotivo: 'OUTRO', baixaJustificativa: '' });
    await pg.disparar('baixaMotivo', 'change');
    assert.equal(pg.el('campoBaixaJustificativa').style.display, '');
    await pg.disparar('botaoRegistrarBaixa');
    assert.equal(escritas().length, 0, 'Outro sem justificativa');
    pg.preencher({ baixaJustificativa: 'Doação para treinamento' });
    estado.lotes = [LOTES[0], { ...LOTES[1], fisico: 16, disponivel: 16 }, LOTES[2]];
    await pg.disparar('botaoRegistrarBaixa');
    const [baixa] = escritas();
    assert.equal(baixa.caminho, '/api/estoque/lotes/2/baixas');
    assert.deepEqual(semChave(baixa.corpo), semChave({ quantidade: 4, motivo: 'OUTRO', justificativa: 'Doação para treinamento' }));
    assert.match(baixa.corpo.chaveIdempotencia, UUID);
    assert.deepEqual([pg.el('saldoFisico').textContent, pg.el('saldoDisponivel').textContent], ['31', '16']);
    assert.match(pg.el('aviso').innerHTML, /Baixa registrada/);
  });

  test('sem MOVIMENTAR_ESTOQUE: blocos de entrada e baixa ocultos; a consulta de lotes continua', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], lotes: LOTES }));
    const pg = montarPagina({ permissoes: { recursos: { materials: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: false });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.deepEqual([pg.el('blocoEntradaEstoque').style.display, pg.el('blocoBaixaEstoque').style.display], ['none', 'none']);
    assert.equal(pg.el('saldoFisico').textContent, '35');
  });
});

describe('óculos com grau — módulo', () => {
  // OCULOS é o nome histórico (só legado gravado); INCOLOR é um dos dois tipos oficiais (12G-8).
  const OCULOS = 'Óculos de proteção';
  const INCOLOR = 'Óculos de Proteção Incolor';
  const F = () => carregarMateriais().formulario;
  const base = (extra = {}) => ({
    nome: 'Óculos', categoria: 'EPI', tipo: INCOLOR, tipoCustom: '', fabricante: '', codigoInterno: '', unidade: 'Unidade', estoqueMinimo: '5',
    prazoUnidade: 'meses', prazo: '6', controleTamanho: 'unico', descricao: '', registrarEntrada: 'nao', quantidadeComprada: '', tamanhoEntrada: '',
    caEntrada: '', caValidadeEntrada: '', ...extra,
  });
  const salvo = (extra = {}) => ({ ...MATERIAL, tipo: OCULOS, exigeTamanho: false, unidade: 'unidade', oculosComGrau: null, ...extra });
  const camposDe = (material, extra = {}) => ({ ...F().camposDoMaterial(material).campos, ...extra });

  test('os tipos de óculos são os da lista (Incolor e Ampla Visão) e o nome histórico; só eles, aparados, são óculos de proteção', () => {
    assert.equal(F().TIPO_OCULOS, OCULOS);
    assert.ok(F().TIPOS.includes(F().TIPOS_OCULOS[0]) && F().TIPOS.includes(F().TIPOS_OCULOS[1]));
    assert.equal(F().TIPOS.includes(OCULOS), false, 'o nome histórico não é oferecido');
    for (const tipo of [OCULOS, `  ${OCULOS} `, INCOLOR, `  ${INCOLOR} `]) assert.equal(F().ehOculos(tipo), true, tipo);
    for (const tipo of ['óculos de proteção', 'Óculos', 'Oculos de protecao', 'Óculos de proteção incolor', 'Luva', '', null, undefined]) {
      assert.equal(F().ehOculos(tipo), false, String(tipo));
    }
  });

  test('cadastro: óculos marcado envia true, desmarcado envia false; outro tipo não envia a informação, mesmo com a caixa marcada', () => {
    assert.equal(F().montarCorpo(base({ oculosComGrau: true })).corpo.oculosComGrau, true);
    assert.equal(F().montarCorpo(base({ oculosComGrau: false })).corpo.oculosComGrau, false);
    assert.equal(F().montarCorpo(base()).corpo.oculosComGrau, false, 'caixa não marcada no cadastro novo = sem grau');
    assert.equal('oculosComGrau' in F().montarCorpo(base({ tipo: 'Luva', controleTamanho: 'grade', oculosComGrau: true })).corpo, false);
    assert.equal('oculosComGrau' in F().montarCorpo(base({ tipo: 'Outros', tipoCustom: OCULOS, oculosComGrau: true })).corpo, false, '"Outros" com texto de óculos não é óculos (12G-8)');
    assert.equal('oculosComGrau' in F().montarCorpo(base({ tipo: 'Outros', tipoCustom: 'Óculos de sol', oculosComGrau: true })).corpo, false);
  });

  test('edição carrega true marcado e false desmarcado; o NULL do legado vem desmarcado e marcado como não classificado', () => {
    assert.deepEqual([camposDe(salvo({ oculosComGrau: true })).oculosComGrau, F().oculosSemClassificacao(salvo({ oculosComGrau: true }))], [true, false]);
    assert.deepEqual([camposDe(salvo({ oculosComGrau: false })).oculosComGrau, F().oculosSemClassificacao(salvo({ oculosComGrau: false }))], [false, false]);
    assert.deepEqual([camposDe(salvo()).oculosComGrau, F().oculosSemClassificacao(salvo())], [false, true]);
    assert.equal(camposDe(salvo()).oculosComGrauTocado, false);
    assert.equal(F().oculosSemClassificacao({ ...MATERIAL, oculosComGrau: null }), false, 'outro tipo não é legado de óculos');
  });

  test('legado NULL: salvar sem mexer não envia nada; alterar outro campo não envia oculosComGrau; mexer na caixa envia true ou false', () => {
    const o = salvo();
    assert.equal(F().montarEdicao(camposDe(o), o).alterado, false);
    assert.deepEqual(F().montarEdicao(camposDe(o, { nome: 'Óculos novo' }), o).corpo, { nome: 'Óculos novo' });
    assert.deepEqual(F().montarEdicao(camposDe(o, { oculosComGrau: true, oculosComGrauTocado: true }), o).corpo, { oculosComGrau: true });
    assert.deepEqual(F().montarEdicao(camposDe(o, { oculosComGrau: false, oculosComGrauTocado: true }), o).corpo, { oculosComGrau: false });
  });

  test('óculos classificados: sem mudança nada vai; trocar a marcação envia o novo valor', () => {
    for (const valor of [true, false]) {
      const o = salvo({ oculosComGrau: valor });
      assert.equal(F().montarEdicao(camposDe(o), o).alterado, false);
      assert.deepEqual(F().montarEdicao(camposDe(o, { oculosComGrau: !valor, oculosComGrauTocado: true }), o).corpo, { oculosComGrau: !valor });
    }
  });

  test('troca de tipo: óculos para Luva envia null; Luva para óculos envia a classificação, marcada ou não', () => {
    const oculos = salvo({ oculosComGrau: true });
    assert.deepEqual(F().montarEdicao(camposDe(oculos, { tipo: 'Luva' }), oculos).corpo, { tipo: 'Luva', oculosComGrau: null });
    const luva = { ...MATERIAL, tipo: 'Luva', oculosComGrau: null };
    for (const valor of [true, false]) {
      assert.deepEqual(F().montarEdicao(camposDe(luva, { tipo: INCOLOR, oculosComGrau: valor }), luva).corpo, { tipo: INCOLOR, oculosComGrau: valor });
    }
  });

  test('mensagens: as recusas do servidor sobre óculos com grau viram texto claro no cadastro e na edição', () => {
    const M = carregarMateriais().mensagens;
    const r = (codigo) => ({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.oculosComGrau', codigo }] });
    for (const fn of [M.erroCadastro, M.erroEdicao]) {
      assert.match(fn(r('OCULOS_COM_GRAU_OBRIGATORIO')), /com grau/i);
      assert.match(fn(r('OCULOS_COM_GRAU_NAO_SE_APLICA')), /óculos de proteção/i);
    }
  });
});

describe('óculos com grau — inspeção estática', () => {
  const html = ler('pages/materials.html');

  test('caixa "Óculos com grau" no formulário, oculta até o tipo ser Óculos de proteção, com o aviso do legado', () => {
    assert.match(html, /<div class="field" id="campoOculosComGrau" style="display:none">/);
    assert.match(html, /<input id="materialOculosComGrau" type="checkbox"/);
    assert.match(html, />\s*Óculos com grau\s*</);
    assert.match(html, /<div class="helper" id="materialOculosComGrauLegado" style="display:none">Não informado no cadastro antigo<\/div>/);
  });

  test('a página decide pelo tipo com formulario.ehOculos, nunca pelo nome do material', () => {
    const script = semComentarios(html.slice(html.lastIndexOf('<script>')));
    assert.match(script, /formulario\.ehOculos\(/);
    assert.equal(/materialNome[^\n]*[Óó]culos|[Óó]culos[^\n]*materialNome/.test(script), false);
  });
});

describe('entrada inicial: bloco próprio do primeiro lote, com CA e validade', () => {
  const html = ler('pages/materials.html');

  test('bloco "Entrada inicial de estoque — primeiro lote": tamanho, quantidade, Número do CA e Validade do CA, nessa ordem, com a nota de que o CA é do lote', () => {
    const inicio = html.indexOf('<div class="field full" id="blocoEntradaInicial" style="display:none">');
    assert.ok(inicio > html.indexOf('id="materialRegistrarEntrada"'), 'o bloco vem logo depois da pergunta da entrada inicial');
    const bloco = html.slice(inicio, html.indexOf('<!-- fim da entrada inicial -->'));
    assert.match(bloco, /Entrada inicial de estoque — primeiro lote/);
    const ordem = ['campoTamanhoEntrada', 'campoTamanhoEntradaUnico', 'campoQuantidadeComprada', 'campoEntradaCa', 'campoEntradaCaValidade'].map((id) => bloco.indexOf(`id="${id}"`));
    assert.ok(ordem.every((p) => p > 0), JSON.stringify(ordem));
    assert.deepEqual([...ordem].sort((a, b) => a - b), ordem);
    assert.match(bloco, /<div class="field" id="campoTamanhoEntradaUnico" style="display:none;align-self:center;font-size:13px">Tamanho: Único<\/div>/);
    assert.match(bloco, /<label for="materialEntradaCa">Número do CA \*<\/label>/);
    assert.match(bloco, /<label for="materialEntradaCaValidade">Validade do CA \*<\/label>/);
    assert.match(bloco, /O CA e a validade ficam no lote desta entrada, não no cadastro do material\. Outras entradas do mesmo material podem ter outro CA\./);
  });

  test('óculos de tamanho único com entrada inicial: "Tamanho: Único", CA e validade no bloco; o material vai sem CA e a entrada leva CA e validade, sem tamanho', async () => {
    servidorRotas(estadoPadrao({ proximoId: 92 }));
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({
      materialNome: 'Óculos com grau', materialCategoria: 'EPI', materialTipo: 'Óculos de Proteção Incolor', materialUnidade: 'Unidade', materialEstoqueMinimo: '2',
      materialValidadeTipo: 'meses', materialPrazo: '12', materialControleTamanho: 'unico', materialRegistrarEntrada: 'sim',
    });
    await pg.disparar('materialTipo', 'change');
    await pg.disparar('materialRegistrarEntrada', 'change');
    const visiveis = (ids) => ids.map((id) => pg.el(id).style.display);
    assert.deepEqual(visiveis(['blocoEntradaInicial', 'campoTamanhoEntradaUnico', 'campoTamanhoEntrada', 'campoQuantidadeComprada', 'campoEntradaCa', 'campoEntradaCaValidade']), ['', '', 'none', '', '', '']);
    pg.el('materialOculosComGrau').checked = true;
    await pg.disparar('materialOculosComGrau', 'change');
    pg.preencher({ materialQuantidadeComprada: '2', materialEntradaCa: '12345', materialEntradaCaValidade: '2028-09-30' });
    await pg.disparar('botaoSalvar');
    const [material, entrada, ...resto] = escritas();
    assert.deepEqual([material.caminho, entrada.caminho, resto.length], ['/api/materiais', '/api/materiais/92/estoque/entradas', 0]);
    assert.deepEqual([material.corpo.oculosComGrau, 'caNumero' in material.corpo, 'caValidade' in material.corpo], [true, false, false]);
    assert.deepEqual(semChave(entrada.corpo), semChave({ quantidade: 2, caNumero: '12345', caValidade: '2028-09-30' }));
  });

  test('"Possui tamanhos" mostra o tamanho no bloco; "Não" esconde o bloco inteiro', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({ materialControleTamanho: 'grade', materialRegistrarEntrada: 'sim' });
    await pg.disparar('materialRegistrarEntrada', 'change');
    assert.deepEqual(['blocoEntradaInicial', 'campoTamanhoEntrada', 'campoTamanhoEntradaUnico'].map((id) => pg.el(id).style.display), ['', '', 'none']);
    pg.el('materialRegistrarEntrada').value = 'nao';
    await pg.disparar('materialRegistrarEntrada', 'change');
    assert.equal(pg.el('blocoEntradaInicial').style.display, 'none');
  });

  test('CA e validade da entrada inicial são obrigatórios: sem eles nada é enviado e os campos são marcados', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({
      materialNome: 'Óculos', materialCategoria: 'EPI', materialTipo: 'Óculos de Proteção Incolor', materialUnidade: 'Unidade', materialEstoqueMinimo: '0',
      materialValidadeTipo: 'meses', materialPrazo: '12', materialControleTamanho: 'unico', materialRegistrarEntrada: 'sim', materialQuantidadeComprada: '2',
    });
    await pg.disparar('materialTipo', 'change');
    await pg.disparar('botaoSalvar');
    assert.equal(escritas().length, 0);
    assert.deepEqual([pg.el('materialEntradaCa').atributos['aria-invalid'], pg.el('materialEntradaCaValidade').atributos['aria-invalid']], ['true', 'true']);
  });
});

describe('óculos com grau — página', () => {
  // OCULOS é o nome histórico (só legado gravado, aceito na edição); INCOLOR é um dos dois tipos oficiais (12G-8).
  const OCULOS = 'Óculos de proteção';
  const INCOLOR = 'Óculos de Proteção Incolor';
  const DOM = (extra = {}) => ({
    materialNome: 'Óculos incolor', materialCategoria: 'EPI', materialTipo: INCOLOR, materialUnidade: 'Unidade', materialEstoqueMinimo: '5',
    materialValidadeTipo: 'meses', materialPrazo: '6', materialControleTamanho: 'unico', materialRegistrarEntrada: 'nao', ...extra,
  });
  const trocarTipo = async (pg, tipo) => { pg.el('materialTipo').value = tipo; await pg.disparar('materialTipo', 'change'); };
  // Visível só com display '' explícito: o elemento simulado nasce sem display.
  const visivel = (pg) => pg.el('campoOculosComGrau').style.display === '';
  const legadoVisivel = (pg) => pg.el('materialOculosComGrauLegado').style.display === '';
  const marcar = async (pg, valor) => { pg.el('materialOculosComGrau').checked = valor; await pg.disparar('materialOculosComGrau', 'change'); };
  const editarMaterial = async (salvo, extra = {}) => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL, exigeTamanho: false, ...salvo, id } }), ...extra }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await pg.disparar('botaoEditarMaterial');
    return pg;
  };

  test('a caixa só aparece para Óculos de proteção; ao sair do tipo, some desmarcada e não volta marcada', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(visivel(pg), false, 'sem tipo escolhido no início');
    for (const tipo of ['Luva', 'Proteção Auricular Concha', 'Capacete', 'Respirador PFF2', 'Outros']) {
      await trocarTipo(pg, tipo);
      assert.equal(visivel(pg), false, tipo);
    }
    for (const oculos of [INCOLOR, 'Óculos de Proteção Ampla Visão']) {
      await trocarTipo(pg, oculos);
      assert.deepEqual([visivel(pg), pg.el('materialOculosComGrau').checked, legadoVisivel(pg)], [true, false, false], oculos);
      await marcar(pg, true);
      await trocarTipo(pg, 'Luva');
      assert.deepEqual([visivel(pg), pg.el('materialOculosComGrau').checked], [false, false], oculos);
      await trocarTipo(pg, oculos);
      assert.equal(pg.el('materialOculosComGrau').checked, false, oculos);
    }
  });

  test('"Outros" com texto de óculos na descrição não mostra a caixa: a descrição é texto, não tipo (12G-8)', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    await trocarTipo(pg, 'Outros');
    for (const texto of ['Óculos de sol', OCULOS, INCOLOR, 'óculos de proteção']) {
      pg.el('materialTipoCustom').value = texto;
      await pg.disparar('materialTipoCustom', 'input');
      assert.equal(visivel(pg), false, texto);
    }
  });

  test('cadastro: óculos marcado envia true, desmarcado envia false; Luva não mostra a caixa nem envia a informação', async () => {
    for (const [extra, marcado, esperado] of [[{}, true, true], [{}, false, false], [{ materialTipo: 'Luva', materialControleTamanho: 'grade' }, null, undefined]]) {
      servidorRotas(estadoPadrao());
      const pg = montarPagina();
      await pg.esperar();
      pg.preencher(DOM(extra));
      await pg.disparar('materialTipo', 'change');
      assert.equal(visivel(pg), marcado !== null);
      if (marcado !== null) await marcar(pg, marcado);
      await pg.disparar('botaoSalvar');
      const [post] = escritas();
      assert.equal(post.caminho, '/api/materiais');
      assert.equal(post.corpo.oculosComGrau, esperado, JSON.stringify(extra));
      assert.equal('oculosComGrau' in post.corpo, esperado !== undefined);
    }
  });

  test('marcar, trocar para Luva e salvar: nenhum valor escondido vai junto', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(DOM());
    await pg.disparar('materialTipo', 'change');
    await marcar(pg, true);
    pg.preencher({ materialControleTamanho: 'grade' });
    await trocarTipo(pg, 'Luva');
    await pg.disparar('botaoSalvar');
    assert.deepEqual([escritas()[0].corpo.tipo, 'oculosComGrau' in escritas()[0].corpo], ['Luva', false]);
  });

  test('edição: true aparece marcado e false desmarcado, sem o aviso de legado; sem mudança nada é enviado', async () => {
    for (const valor of [true, false]) {
      const pg = await editarMaterial({ tipo: OCULOS, oculosComGrau: valor });
      assert.deepEqual([visivel(pg), pg.el('materialOculosComGrau').checked, legadoVisivel(pg)], [true, valor, false]);
      await pg.disparar('botaoSalvar');
      assert.equal(escritas().length, 0);
    }
  });

  test('edição de legado NULL: caixa desmarcada com o aviso; renomear não classifica', async () => {
    const pg = await editarMaterial({ tipo: OCULOS, oculosComGrau: null });
    assert.deepEqual([visivel(pg), pg.el('materialOculosComGrau').checked, legadoVisivel(pg)], [true, false, true]);
    pg.el('materialNome').value = 'Óculos legado renomeado';
    await pg.disparar('botaoSalvar');
    assert.deepEqual(escritas().map((c) => c.corpo), [{ nome: 'Óculos legado renomeado' }]);
  });

  test('edição de legado NULL: mexer na caixa tira o aviso e classifica; marcar e desmarcar vira "sem grau"', async () => {
    for (const cliques of [[true], [true, false]]) {
      const pg = await editarMaterial({ tipo: OCULOS, oculosComGrau: null });
      for (const valor of cliques) await marcar(pg, valor);
      assert.equal(legadoVisivel(pg), false);
      await pg.disparar('botaoSalvar');
      assert.deepEqual(escritas().map((c) => c.corpo), [{ oculosComGrau: cliques.at(-1) }]);
    }
  });

  test('edição: óculos para Luva envia null; Luva para óculos mostra a caixa desmarcada, sem aviso de legado, e envia a escolha', async () => {
    const pg = await editarMaterial({ tipo: OCULOS, oculosComGrau: true });
    await trocarTipo(pg, 'Luva');
    assert.equal(visivel(pg), false);
    await pg.disparar('botaoSalvar');
    assert.deepEqual(escritas().map((c) => c.corpo), [{ tipo: 'Luva', oculosComGrau: null }]);

    const luva = await editarMaterial({ tipo: 'Luva', oculosComGrau: null });
    assert.equal(visivel(luva), false);
    await trocarTipo(luva, INCOLOR);
    assert.deepEqual([visivel(luva), luva.el('materialOculosComGrau').checked, legadoVisivel(luva)], [true, false, false]);
    await luva.disparar('botaoSalvar');
    assert.deepEqual(escritas().map((c) => c.corpo), [{ tipo: INCOLOR, oculosComGrau: false }]);
  });

  test('edição: voltar ao tipo original mostra o valor gravado, não a marcação feita antes da troca', async () => {
    const pg = await editarMaterial({ tipo: OCULOS, oculosComGrau: false });
    await marcar(pg, true);
    await trocarTipo(pg, 'Luva');
    await trocarTipo(pg, OCULOS);
    assert.equal(pg.el('materialOculosComGrau').checked, false);
    await pg.disparar('botaoSalvar');
    assert.equal(escritas().length, 0);
  });

  test('recusa do servidor sobre óculos com grau: mensagem clara e a edição continua aberta', async () => {
    const pg = await editarMaterial({ tipo: OCULOS, oculosComGrau: null }, {
      alterar: () => resposta(400, { status: 'error', codigo: 'VALIDACAO', detalhes: [{ campo: 'body.oculosComGrau', codigo: 'OCULOS_COM_GRAU_OBRIGATORIO' }] }),
    });
    await marcar(pg, true);
    await pg.disparar('botaoSalvar');
    assert.match(pg.el('aviso').innerHTML, /com grau/i);
    assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
  });
});

describe('segurança: conteúdo vindo da API aparece como texto, nunca como elemento ou evento', () => {
  const ATAQUE = '<img src=x onerror=alert(1)>';
  const ESCAPADO = '&lt;img src=x onerror=alert(1)&gt;';
  // Marcações de um trecho de HTML: só as da própria página podem existir.
  const marcacoes = (html) => [...String(html).matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ nome: m[1].toLowerCase(), atributos: m[2] }));
  // Nomes de atributo, com os valores entre aspas neutralizados: texto escapado
  // dentro de value="..." não é atributo; uma aspa que escapasse seria.
  const nomesDeAtributo = (atributos) => [...atributos.replace(/"[^"]*"|'[^']*'/g, '""').matchAll(/([^\s="'/]+)\s*=/g)].map((m) => m[1].toLowerCase());
  const semElementoInjetado = (html) => {
    for (const m of marcacoes(html)) {
      assert.notEqual(m.nome, 'img', html);
      assert.equal(nomesDeAtributo(m.atributos).some((nome) => nome.startsWith('on')), false, `atributo de evento em <${m.nome}>: ${html}`);
    }
  };

  test('o verificador pega o que importa: <img> injetado ou aspa que escapa do atributo', () => {
    assert.throws(() => semElementoInjetado(`<option>${ATAQUE}</option>`));
    assert.throws(() => semElementoInjetado('<option value="x" onerror=alert(1)>x</option>'));
    semElementoInjetado(`<option value="${ESCAPADO}">${ESCAPADO}</option>`);
  });

  test('nome e código do material no seletor: texto escapado, sem <img> e sem atributo de evento', async () => {
    servidorRotas(estadoPadrao({ materiais: [{ ...MATERIAL, nome: ATAQUE, codigoInterno: `"><${ATAQUE}` }] }));
    const pg = montarPagina();
    await pg.esperar();
    const html = pg.el('gradeMaterial').innerHTML;
    assert.ok(html.includes(ESCAPADO), html);
    semElementoInjetado(html);
  });

  test('tamanho, CA e situação do lote: tabela, opções da baixa e tamanhos da entrada escapados; situação desconhecida não entra na classe', async () => {
    const lotes = [lote({ tamanho: ATAQUE, caNumero: ATAQUE, caValidade: ATAQUE, situacaoCa: ATAQUE })];
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], lotes, materialEstoque: { exigeTamanho: true } }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    for (const id of ['lotesCorpo', 'baixaLote', 'entradaTamanho']) {
      assert.ok(pg.el(id).innerHTML.includes(ESCAPADO), id);
      semElementoInjetado(pg.el(id).innerHTML);
    }
    assert.match(pg.el('lotesCorpo').innerHTML, /<span class="badge badge-warning">/);
  });

  test('nome do material no aviso da entrada e campos do erro do servidor: escapados', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], materialEstoque: { exigeTamanho: false, nome: ATAQUE } }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaQuantidade: '5', entradaCa: '38271', entradaCaValidade: '2030-12-31' });
    await pg.disparar('botaoRegistrarEntrada');
    assert.match(pg.el('aviso').innerHTML, /Entrada registrada/);
    assert.ok(pg.el('aviso').innerHTML.includes(ESCAPADO));
    semElementoInjetado(pg.el('aviso').innerHTML);

    servidorRotas(estadoPadrao({
      materiais: [MATERIAL],
      alterar: () => resposta(400, { status: 'error', codigo: 'VALIDACAO', detalhes: [{ campo: ATAQUE, codigo: 'X' }] }),
    }));
    const edicao = montarPagina({ permissoes: PODE_EDITAR });
    await edicao.esperar();
    await escolherMaterial(edicao);
    await edicao.disparar('botaoEditarMaterial');
    edicao.el('materialNome').value = 'Outro nome';
    await edicao.disparar('botaoSalvar');
    assert.ok(edicao.el('aviso').innerHTML.includes(ESCAPADO), edicao.el('aviso').innerHTML);
    semElementoInjetado(edicao.el('aviso').innerHTML);
  });

  test('modo edição: o nome do material vai por textContent, nunca por innerHTML', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL, id, nome: ATAQUE } }) }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await pg.disparar('botaoEditarMaterial');
    assert.ok(pg.el('modoEdicao').textContent.includes(ATAQUE));
    assert.equal(pg.el('modoEdicao').innerHTML, '');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12D-3 — "Mínimo padrão" no cadastro, painel do mínimo por tamanho
// (GET/PUT/DELETE /materiais/:id/minimos) e a recusa SALDO_LIVRE_INSUFICIENTE
// na baixa. Módulo do painel: test/estoque-minimos.test.js.
// ═══════════════════════════════════════════════════════════════════

describe('12D-3 — cadastro: "Mínimo padrão" no lugar de "Estoque mínimo"', () => {
  const html = ler('pages/materials.html');

  test('rótulo e explicação: o mínimo do cadastro é o padrão, usado por tamanhos sem mínimo específico; o rótulo antigo saiu', () => {
    assert.match(html, /<label for="materialEstoqueMinimo">Mínimo padrão<\/label>/);
    assert.match(html, /Usado para tamanhos que não possuem mínimo específico\./);
    assert.equal(/<label for="materialEstoqueMinimo">Estoque mínimo<\/label>/.test(html), false);
  });

  test('mensagens do módulo: a validação fala em "mínimo padrão"', () => {
    const { formulario } = carregarMateriais();
    const msg = (r, campo) => r.erros.find((e) => e.campo === campo).mensagem;
    assert.match(msg(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '-1' }), 'estoqueMinimo'), /^Mínimo padrão deve ser um inteiro maior ou igual a zero\./);
    assert.match(msg(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '2147483648' }), 'estoqueMinimo'), /^Mínimo padrão acima do limite/);
    const campos = formulario.camposDoMaterial(MATERIAL).campos;
    assert.equal(msg(formulario.montarEdicao({ ...campos, estoqueMinimo: '' }, MATERIAL), 'estoqueMinimo'), 'Informe o mínimo padrão (use 0 para nenhum).');
  });

  test('o campo da API continua estoqueMinimo: só o texto mudou', () => {
    const { formulario } = carregarMateriais();
    assert.equal(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '7' }).corpo.estoqueMinimo, 7);
    assert.equal(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '0' }).corpo.estoqueMinimo, 0, 'zero é um mínimo padrão válido');
  });

  test('edição: trocar o controle de tamanho com mínimos por tamanho configurados é recusado com a orientação de removê-los', () => {
    const { mensagens } = carregarMateriais();
    const texto = mensagens.erroEdicao({ ok: false, status: 409, codigo: 'MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS', mensagem: 'SEGREDO-INTERNO' });
    assert.match(texto, /mínimos por tamanho/i);
    assert.match(texto, /Remova/i);
    assert.equal(/SEGREDO/.test(texto), false);
    assert.notEqual(texto, mensagens.MSG.EDICAO_GENERICO);
  });
});

describe('12D-3 — baixa: SALDO_LIVRE_INSUFICIENTE para as baixas discricionárias', () => {
  test('mensagem de domínio: o saldo físico existe, mas a baixa reduziria o comprometido; devolução e "Outro" só usam o saldo livre; sem número nem dado de terceiros', () => {
    const { mensagens } = carregarMateriais();
    const texto = mensagens.erroBaixa({ ok: false, status: 409, codigo: 'SALDO_LIVRE_INSUFICIENTE', mensagem: 'SEGREDO-INTERNO' });
    assert.match(texto, /^o saldo físico existe, mas esta baixa reduziria o estoque comprometido com solicitações já aprovadas/);
    assert.match(texto, /saldo livre/);
    assert.match(texto, /Devolução ao fornecedor/);
    assert.match(texto, /Outro/);
    assert.equal(/saldo atual do lote/.test(texto), false, 'não é o saldo do lote');
    assert.notEqual(texto, mensagens.erroBaixa({ ok: false, status: 409, codigo: 'SALDO_LOTE_INSUFICIENTE' }));
    assert.equal(/SEGREDO|\d/.test(texto), false);
  });

  test('a orientação manda registrar o motivo conforme o que aconteceu, sem sugerir um motivo físico para passar', () => {
    const { mensagens } = carregarMateriais();
    const texto = mensagens.erroBaixa({ ok: false, status: 409, codigo: 'SALDO_LIVRE_INSUFICIENTE' });
    assert.match(texto, /conforme o que realmente aconteceu/);
    assert.equal(/escolha (o motivo|um motivo) (de )?(avaria|perda|descarte|ajuste)/i.test(texto), false);
    assert.equal(/para (contornar|evitar)/i.test(texto), false);
  });

  test('resultadoBaixa: é recusa confirmada (4xx), nunca "não confirmada"', () => {
    const { mensagens } = carregarMateriais();
    const r = { ok: false, confirmado: true, resposta: { ok: false, status: 409, codigo: 'SALDO_LIVRE_INSUFICIENTE' } };
    const texto = mensagens.resultadoBaixa(r, { quantidade: 2, motivo: 'OUTRO' }, { tamanho: '41', caNumero: '54321' });
    assert.match(texto, /^Baixa não realizada: o saldo físico existe/);
    assert.equal(/não confirmada/.test(texto), false);
  });

  test('aviso do motivo: só devolução ao fornecedor e "Outro" dependem do saldo livre; os fatos físicos não ganham dica', () => {
    const { mensagens } = carregarMateriais();
    for (const motivo of ['DEVOLUCAO_FORNECEDOR', 'OUTRO']) assert.match(mensagens.avisoMotivoBaixa(motivo), /só pode usar o saldo livre/);
    for (const motivo of ['CA_VENCIDO', 'AVARIA', 'DESCARTE', 'PERDA', 'AJUSTE_INVENTARIO', '', undefined, 'QUALQUER']) assert.equal(mensagens.avisoMotivoBaixa(motivo), '', String(motivo));
  });
});

// Servidor falso por rota com os mínimos por tamanho (as demais rotas vêm do estadoPadrao).
function estadoComMinimos({ minimos = {}, ...extra } = {}) {
  const e = estadoPadrao({ materiais: [MATERIAL], lotes: LOTES, materialEstoque: { exigeTamanho: true }, ...extra });
  e.minimos = { estoqueMinimoPadrao: 5, exigeTamanho: true, overrides: [], ...minimos };
  e.falhaMinimos = null; // (metodo, tamanho) => resposta | Error | undefined
  const estado = (mais = {}) => ({
    status: 'ok', materialId: 77, estoqueMinimoPadrao: e.minimos.estoqueMinimoPadrao, exigeTamanho: e.minimos.exigeTamanho, overrides: e.minimos.overrides.map((o) => ({ ...o })), ...mais,
  });
  const base = e.responder;
  e.responder = (metodo, u, corpo) => {
    const m = u.pathname.match(/^\/api\/materiais\/(\d+)\/minimos(?:\/([^/]+))?$/);
    if (!m) return base(metodo, u, corpo);
    const tamanho = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
    const falha = e.falhaMinimos && e.falhaMinimos(metodo, tamanho);
    if (falha) return falha;
    if (metodo === 'GET' && tamanho === undefined) return resposta(200, estado());
    const i = e.minimos.overrides.findIndex((o) => o.tamanho === tamanho);
    if (metodo === 'PUT') {
      const criado = i < 0;
      const alterado = criado || e.minimos.overrides[i].minimo !== corpo.minimo;
      if (criado) e.minimos.overrides.push({ tamanho, minimo: corpo.minimo }); else e.minimos.overrides[i].minimo = corpo.minimo;
      return resposta(criado ? 201 : 200, estado({ criado, alterado }));
    }
    if (metodo === 'DELETE') {
      if (i >= 0) e.minimos.overrides.splice(i, 1);
      return resposta(200, estado({ alterado: i >= 0 }));
    }
    return resposta(404, { status: 'erro', codigo: 'NAO_ENCONTRADO' });
  };
  return e;
}
const chamadasMinimos = () => chamadas.filter((c) => /\/minimos/.test(c.caminho));

describe('12D-3 — página: mínimo por tamanho (painel, definir, alterar, remover)', () => {
  const html = ler('pages/materials.html');
  const codigo = semComentarios(html);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  // O painel escreve os textos por textContent (nunca por innerHTML).
  const textoDe = (pg, id) => pg.el(id).textContent.replace(/\s+/g, ' ').trim();
  const linhasDoPainel = (pg) => pg.el('minimosCorpo').innerHTML.split('</tr>').filter((l) => l.includes('<td')).map((l) => [...l.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 4));
  /** Clique de linha: a página delega no corpo da tabela e acha o botão por data-acao e data-tamanho. */
  const clicarLinha = async (pg, acao, tamanho) => {
    const botao = { disabled: false, getAttribute: (k) => ({ 'data-acao': acao, 'data-tamanho': tamanho })[k] || null };
    for (const fn of (pg.el('minimosCorpo').listeners.click || [])) await fn({ target: { closest: () => botao } });
    await pg.esperar();
  };

  test('estática: cartão "Estoque mínimo por tamanho" com tabela, formulário rotulado, região de status e o módulo carregado; nada no navegador', () => {
    assert.match(html, /<h2>Estoque mínimo por tamanho<\/h2>/);
    for (const id of ['cardMinimos', 'minimosAviso', 'minimosCorpo', 'blocoMinimos', 'minimoTamanho', 'minimoTamanhosLista', 'minimoValor', 'botaoDefinirMinimo', 'minimosStatus']) assert.ok(ids.includes(id), `falta #${id}`);
    assert.match(html, /<label for="minimoTamanho">Tamanho \*<\/label>/);
    assert.match(html, /<label for="minimoValor">Mínimo \*<\/label>/);
    assert.match(html, /<input id="minimoTamanho"[^>]*maxlength="20"/);
    assert.match(html, /id="minimosStatus"[^>]*role="status"[^>]*aria-live="polite"|id="minimosStatus"[^>]*aria-live="polite"[^>]*role="status"/);
    const cabecalho = html.slice(html.indexOf('id="cardMinimos"'));
    assert.deepEqual([...cabecalho.slice(0, cabecalho.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ['Tamanho', 'Mínimo próprio', 'Mínimo efetivo', 'Origem', '']);
    assert.match(codigo, /EpiEstoqueMinimos/);
    assert.equal(/localStorage|sessionStorage/.test(codigo), false);
  });

  test('ao escolher o material: GET dos mínimos; uma linha por tamanho com lote ou sobrescrita; "0 próprio" diferente de "herdando padrão"; o padrão explicado', async () => {
    servidorRotas(estadoComMinimos({ minimos: { overrides: [{ tamanho: '40', minimo: 0 }, { tamanho: '44', minimo: 9 }] } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.deepEqual(chamadasMinimos().map((c) => `${c.metodo} ${c.caminho}`), ['GET /api/materiais/77/minimos']);
    assert.deepEqual(linhasDoPainel(pg), [
      ['40', '0 próprio', '0', 'Próprio'],
      ['41', 'herdando padrão', '5', 'Padrão'],
      ['44', '9 próprio', '9', 'Próprio'],
    ]);
    assert.match(textoDe(pg, 'minimosAviso'), /mínimo padrão \(5\)/);
    assert.equal(pg.el('blocoMinimos').style.display, '');
    assert.match(pg.el('minimoTamanhosLista').innerHTML, /<option value="41">/);
  });

  test('definir: PUT só com { minimo } no tamanho certo; o painel passa a mostrar o próprio; mensagem de sucesso; nenhuma linha extra para outros tamanhos', async () => {
    servidorRotas(estadoComMinimos());
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ minimoTamanho: ' 41 ', minimoValor: '3' });
    await pg.disparar('botaoDefinirMinimo');
    assert.deepEqual(escritas().map((c) => [c.metodo, c.caminho, c.corpo]), [['PUT', '/api/materiais/77/minimos/41', { minimo: 3 }]]);
    assert.deepEqual(linhasDoPainel(pg).map((l) => l[0]), ['40', '41']);
    assert.deepEqual(linhasDoPainel(pg).find((l) => l[0] === '41'), ['41', '3 próprio', '3', 'Próprio']);
    assert.equal(pg.el('minimosStatus').textContent, 'Mínimo do tamanho 41 definido: 3.');
    assert.deepEqual([pg.el('minimoTamanho').value, pg.el('minimoValor').value], ['', ''], 'formulário limpo depois de gravar');
  });

  test('o zero próprio é enviado e mostrado como zero próprio, não como "herdando padrão"', async () => {
    servidorRotas(estadoComMinimos());
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ minimoTamanho: '41', minimoValor: '0' });
    await pg.disparar('botaoDefinirMinimo');
    assert.deepEqual(escritas()[0].corpo, { minimo: 0 });
    assert.deepEqual(linhasDoPainel(pg).find((l) => l[0] === '41'), ['41', '0 próprio', '0', 'Próprio']);
  });

  test('Alterar traz o tamanho e o valor atuais para o formulário; gravar o mesmo valor é "nada alterado"; outro valor, "alterado para"', async () => {
    servidorRotas(estadoComMinimos({ minimos: { overrides: [{ tamanho: '41', minimo: 7 }] } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await clicarLinha(pg, 'alterar', '41');
    assert.deepEqual([pg.el('minimoTamanho').value, pg.el('minimoValor').value], ['41', '7']);
    await pg.disparar('botaoDefinirMinimo');
    assert.equal(pg.el('minimosStatus').textContent, 'O tamanho 41 já tinha o mínimo 7; nada foi alterado.');
    pg.preencher({ minimoTamanho: '41', minimoValor: '8' });
    await pg.disparar('botaoDefinirMinimo');
    assert.equal(pg.el('minimosStatus').textContent, 'Mínimo do tamanho 41 alterado para 8.');
    assert.deepEqual(linhasDoPainel(pg).find((l) => l[0] === '41'), ['41', '8 próprio', '8', 'Próprio']);
  });

  test('Definir numa linha que herda leva só o tamanho ao formulário e põe o foco no mínimo', async () => {
    servidorRotas(estadoComMinimos());
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await clicarLinha(pg, 'definir', '41');
    assert.deepEqual([pg.el('minimoTamanho').value, pg.el('minimoValor').value], ['41', '']);
  });

  test('Remover: DELETE do tamanho; a linha volta a "herdando padrão" com o mínimo padrão; mensagem diz que voltou ao padrão', async () => {
    servidorRotas(estadoComMinimos({ minimos: { overrides: [{ tamanho: '41', minimo: 0 }] } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.deepEqual(linhasDoPainel(pg).find((l) => l[0] === '41'), ['41', '0 próprio', '0', 'Próprio']);
    await clicarLinha(pg, 'remover', '41');
    assert.deepEqual(escritas().map((c) => [c.metodo, c.caminho, c.corpo]), [['DELETE', '/api/materiais/77/minimos/41', undefined]]);
    assert.deepEqual(linhasDoPainel(pg).find((l) => l[0] === '41'), ['41', 'herdando padrão', '5', 'Padrão']);
    assert.equal(pg.el('minimosStatus').textContent, 'Mínimo próprio do tamanho 41 removido: o tamanho volta a usar o mínimo padrão (5).');
  });

  test('tamanho único (exigeTamanho false): sem formulário nem tabela, só o mínimo padrão explicado; nenhuma escrita é possível', async () => {
    servidorRotas(estadoComMinimos({ minimos: { exigeTamanho: false } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.equal(pg.el('blocoMinimos').style.display, 'none');
    assert.equal(pg.el('minimosCorpo').innerHTML, '');
    assert.match(textoDe(pg, 'minimosAviso'), /não usa tamanho.*mínimo padrão \(5\)/i);
    pg.preencher({ minimoTamanho: '41', minimoValor: '3' });
    await pg.disparar('botaoDefinirMinimo');
    assert.equal(escritas().length, 0);
  });

  test('material não classificado (exigeTamanho nulo): orientação de classificar no cadastro, sem formulário e sem sobrescritas mostradas', async () => {
    servidorRotas(estadoComMinimos({ minimos: { exigeTamanho: null, overrides: [{ tamanho: '41', minimo: 2 }] } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.equal(pg.el('blocoMinimos').style.display, 'none');
    assert.equal(pg.el('minimosCorpo').innerHTML, '');
    assert.match(textoDe(pg, 'minimosAviso'), /Defina no cadastro/);
  });

  test('sem permissão de editar: a tabela aparece, mas sem formulário e sem botões de ação; nenhuma escrita', async () => {
    servidorRotas(estadoComMinimos({ minimos: { overrides: [{ tamanho: '41', minimo: 2 }] } }));
    const pg = montarPagina({ permissoes: { recursos: { materials: { visualizar: true, criar: false, editar: false, excluir: false } }, acoes: {}, administracao: {} }, podeAlterar: false });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.equal(linhasDoPainel(pg).length, 2);
    assert.equal(/<button/.test(pg.el('minimosCorpo').innerHTML), false);
    assert.equal(pg.el('blocoMinimos').style.display, 'none');
    await clicarLinha(pg, 'remover', '41');
    pg.preencher({ minimoTamanho: '41', minimoValor: '3' });
    await pg.disparar('botaoDefinirMinimo');
    assert.equal(escritas().length, 0);
  });

  test('valores inválidos: nada é enviado, o campo é marcado e a mensagem explica; o servidor não é consultado', async () => {
    servidorRotas(estadoComMinimos());
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    for (const [tamanho, valor, campo] of [['41', '', 'minimoValor'], ['41', '-1', 'minimoValor'], ['41', '1.5', 'minimoValor'], ['41', 'abc', 'minimoValor'], ['', '3', 'minimoTamanho'], ['x'.repeat(21), '3', 'minimoTamanho']]) {
      pg.preencher({ minimoTamanho: tamanho, minimoValor: valor });
      await pg.disparar('botaoDefinirMinimo');
      assert.equal(pg.el(campo).atributos['aria-invalid'], 'true', `${tamanho}/${valor}`);
      assert.notEqual(pg.el('minimosStatus').textContent, '');
    }
    assert.equal(escritas().length, 0);
  });

  test('409 do servidor não é contornado: mostra a orientação própria e recarrega o painel (o estado pode ter mudado)', async () => {
    const estado = estadoComMinimos();
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    estado.falhaMinimos = (m) => (m === 'PUT' ? resposta(409, { status: 'error', codigo: 'MATERIAL_NAO_EXIGE_TAMANHO', message: 'SEGREDO-INTERNO' }) : undefined);
    estado.minimos.exigeTamanho = false; // o cadastro mudou em outra aba
    pg.preencher({ minimoTamanho: '41', minimoValor: '3' });
    await pg.disparar('botaoDefinirMinimo');
    assert.match(pg.el('minimosStatus').textContent, /não usa tamanho.*mínimo padrão do cadastro/i);
    assert.equal(/SEGREDO/.test(pg.el('minimosStatus').textContent), false);
    assert.equal(escritas().length, 1, 'uma tentativa só, sem repetir');
    assert.deepEqual(chamadasMinimos().map((c) => c.metodo), ['GET', 'PUT', 'GET'], 'o painel foi recarregado');
    assert.equal(pg.el('blocoMinimos').style.display, 'none');
  });

  test('falha de rede na gravação: mensagem de não confirmado, o painel é recarregado para conferir e os botões voltam', async () => {
    const estado = estadoComMinimos();
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    estado.falhaMinimos = (m) => (m === 'PUT' ? new TypeError('Failed to fetch') : undefined);
    pg.preencher({ minimoTamanho: '41', minimoValor: '3' });
    await pg.disparar('botaoDefinirMinimo');
    assert.match(pg.el('minimosStatus').textContent, /não foi possível confirmar se o mínimo foi salvo/i);
    assert.equal(pg.el('botaoDefinirMinimo').disabled, false);
    assert.deepEqual(chamadasMinimos().map((c) => c.metodo), ['GET', 'PUT', 'GET']);
  });

  test('401 na gravação devolve ao Portal e limpa o painel', async () => {
    const estado = estadoComMinimos({ minimos: { overrides: [{ tamanho: '41', minimo: 2 }] } });
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    estado.falhaMinimos = (m) => (m === 'DELETE' ? resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA' }) : undefined);
    await clicarLinha(pg, 'remover', '41');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('falha ao consultar os mínimos: aviso próprio no painel (não no aviso geral), sem tabela e sem formulário; o estoque por lote segue funcionando', async () => {
    const estado = estadoComMinimos();
    estado.falhaMinimos = () => resposta(500, { status: 'error', codigo: 'ERRO_INTERNO' });
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.match(textoDe(pg, 'minimosAviso'), /Não foi possível consultar os mínimos/);
    assert.equal(pg.el('minimosCorpo').innerHTML, '');
    assert.equal(pg.el('blocoMinimos').style.display, 'none');
    assert.equal(pg.el('saldoFisico').textContent, '35', 'os lotes carregaram');
    assert.equal(/mínimos/i.test(pg.el('aviso').innerHTML), false);
  });

  test('trocar de material enquanto os mínimos do anterior carregam: a resposta antiga é descartada', async () => {
    const estado = estadoComMinimos({ materiais: [MATERIAL, { ...MATERIAL, id: 78, nome: 'Luva' }] });
    let liberar77;
    const base = estado.responder;
    // Só o GET dos mínimos do material 77 fica pendente; o resto responde na hora.
    estado.responder = (metodo, u, corpo) => {
      if (metodo === 'GET' && u.pathname === '/api/materiais/77/minimos') {
        return new Promise((resolver) => { liberar77 = () => resolver(resposta(200, { status: 'ok', materialId: 77, estoqueMinimoPadrao: 5, exigeTamanho: true, overrides: [{ tamanho: '99', minimo: 1 }] })); });
      }
      return base(metodo, u, corpo);
    };
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    pg.el('gradeMaterial').value = '77';
    await pg.disparar('gradeMaterial', 'change');
    pg.el('gradeMaterial').value = '78';
    await pg.disparar('gradeMaterial', 'change');
    liberar77();
    await pg.esperar();
    assert.equal(linhasDoPainel(pg).some((l) => l[0] === '99'), false, 'a sobrescrita do material 77 não aparece no 78');
  });

  test('encerrar a sessão limpa o painel, o formulário e a mensagem', async () => {
    servidorRotas(estadoComMinimos({ minimos: { overrides: [{ tamanho: '41', minimo: 2 }] } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ minimoTamanho: '41', minimoValor: '3' });
    pg.sandbox.opcoesMontar.aoEncerrar();
    assert.equal(pg.el('minimosCorpo').innerHTML, '');
    assert.deepEqual([pg.el('minimoTamanho').value, pg.el('minimoValor').value, pg.el('minimosStatus').textContent], ['', '', '']);
    assert.equal(pg.el('blocoMinimos').style.display, 'none');
  });

  test('XSS: o tamanho vindo do servidor sai escapado na tabela e nas sugestões do campo', async () => {
    const ATAQUE_TAMANHO = '<b onclick=x>';
    servidorRotas(estadoComMinimos({ minimos: { overrides: [{ tamanho: ATAQUE_TAMANHO, minimo: 1 }] } }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    for (const html2 of [pg.el('minimosCorpo').innerHTML, pg.el('minimoTamanhosLista').innerHTML]) {
      assert.ok(html2.includes('&lt;b onclick=x&gt;'), html2);
      assert.equal(/<b[\s>]/.test(html2), false);
    }
  });
});

describe('12D-3 — página: baixa discricionária recusada por saldo livre', () => {
  const preparar = async (motivo) => {
    const estado = estadoComMinimos({ baixa: () => resposta(409, { status: 'error', codigo: 'SALDO_LIVRE_INSUFICIENTE', message: 'SEGREDO-INTERNO' }) });
    servidorRotas(estado);
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    pg.el('baixaLote').value = '2';
    await pg.disparar('baixaLote', 'change');
    pg.preencher({ baixaQuantidade: '4', baixaMotivo: motivo, baixaJustificativa: motivo === 'OUTRO' ? 'Doação para treinamento' : '' });
    await pg.disparar('baixaMotivo', 'change');
    return pg;
  };

  test('devolução ao fornecedor: a explicação do saldo livre aparece já ao escolher o motivo, antes de qualquer tentativa', async () => {
    const pg = await preparar('DEVOLUCAO_FORNECEDOR');
    assert.match(pg.el('baixaMotivoHelper').textContent, /só pode usar o saldo livre/);
    assert.equal(escritas().length, 0);
  });

  test('motivos físicos não ganham dica de saldo livre', async () => {
    const pg = await preparar('AVARIA');
    assert.equal(pg.el('baixaMotivoHelper').textContent, '');
  });

  test('recusa 409: aviso de erro com a explicação; o formulário e os lotes ficam como estavam; nada vaza do servidor; uma tentativa só', async () => {
    const pg = await preparar('OUTRO');
    await pg.disparar('botaoRegistrarBaixa');
    const aviso = pg.el('aviso').innerHTML;
    assert.match(aviso, /Baixa não realizada: o saldo físico existe, mas esta baixa reduziria o estoque comprometido/);
    assert.equal(/SEGREDO/.test(aviso), false);
    assert.equal(/C07000/.test(aviso), false, 'recusa confirmada é erro, não "atenção"');
    assert.equal(escritas().length, 1);
    assert.deepEqual([pg.el('baixaQuantidade').value, pg.el('baixaMotivo').value, pg.el('baixaJustificativa').value], ['4', 'OUTRO', 'Doação para treinamento']);
    assert.equal(pg.el('botaoRegistrarBaixa').disabled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12G-8: grade de tamanhos do material. A grade é do cadastro, explícita,
// nunca deduzida dos lotes; material sem grade segue como antes.
// ═══════════════════════════════════════════════════════════════════

describe('12G-8 — grade de tamanhos: módulo', () => {
  test('lerGrade: tamanhos separados por vírgula, aparados e na ordem digitada; vazio é "sem grade"', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.lerGrade(' 38, 39 ,40 '), { tamanhos: ['38', '39', '40'], erro: null });
    assert.deepEqual(formulario.lerGrade(''), { tamanhos: [], erro: null });
    assert.deepEqual(formulario.lerGrade(' , ,'), { tamanhos: [], erro: null });
    assert.deepEqual(formulario.lerGrade('PP,P,M').tamanhos, ['PP', 'P', 'M']);
  });

  test('lerGrade recusa tamanho repetido (sem diferenciar maiúsculas), longo demais e grade com mais de 50 tamanhos', () => {
    const { formulario } = carregarMateriais();
    for (const texto of ['M, m', '40, 40', 'x'.repeat(21), Array.from({ length: 51 }, (_, i) => `T${i}`).join(',')]) {
      const r = formulario.lerGrade(texto);
      assert.deepEqual(r.tamanhos, [], texto);
      assert.equal(typeof r.erro, 'string', texto);
    }
  });

  test('cadastro com "Possui tamanhos": a grade vai no corpo; em branco, nada vai (legado); em "Tamanho único", a grade nunca vai', () => {
    const { formulario } = carregarMateriais();
    const base = { nome: 'Botina', categoria: 'EPI', tipo: 'Botina de Segurança', unidade: 'Par', prazo: '6', prazoUnidade: 'meses', registrarEntrada: 'nao' };
    assert.deepEqual(formulario.montarCorpo({ ...base, controleTamanho: 'grade', grade: '38, 39' }).corpo.tamanhos, ['38', '39']);
    assert.equal(Object.hasOwn(formulario.montarCorpo({ ...base, controleTamanho: 'grade', grade: '' }).corpo, 'tamanhos'), false);
    assert.equal(Object.hasOwn(formulario.montarCorpo({ ...base, controleTamanho: 'unico', grade: '38' }).corpo, 'tamanhos'), false);
    const repetida = formulario.montarCorpo({ ...base, controleTamanho: 'grade', grade: 'M, m' });
    assert.equal(repetida.ok, false);
    assert.deepEqual(repetida.erros.map((e) => e.campo), ['grade']);
  });

  test('entrada inicial com grade: o tamanho tem de ser da grade', () => {
    const { formulario } = carregarMateriais();
    const base = {
      nome: 'Botina', categoria: 'EPI', tipo: 'Botina de Segurança', unidade: 'Par', prazo: '6', prazoUnidade: 'meses', controleTamanho: 'grade', grade: '38, 39',
      registrarEntrada: 'sim', quantidadeComprada: '5', caEntrada: '38271', caValidadeEntrada: '2030-01-31',
    };
    assert.equal(formulario.montarCorpo({ ...base, tamanhoEntrada: '39' }).ok, true);
    const fora = formulario.montarCorpo({ ...base, tamanhoEntrada: '42' });
    assert.equal(fora.ok, false);
    assert.deepEqual(fora.erros.map((e) => e.campo), ['tamanhoEntrada']);
  });

  test('edição: a grade só vai no PATCH quando muda; passar a tamanho único tira a grade junto', () => {
    const { formulario } = carregarMateriais();
    const original = { ...MATERIAL, tamanhos: ['P', 'M'] };
    const campos = formulario.camposDoMaterial(original).campos;
    assert.equal(campos.grade, 'P, M');
    assert.equal(Object.hasOwn(formulario.montarEdicao(campos, original).corpo, 'tamanhos'), false);
    assert.deepEqual(formulario.montarEdicao({ ...campos, grade: 'P, M, G' }, original).corpo, { tamanhos: ['P', 'M', 'G'] });
    assert.deepEqual(formulario.montarEdicao({ ...campos, grade: '' }, original).corpo, { tamanhos: [] });
    assert.deepEqual(formulario.montarEdicao({ ...campos, controleTamanho: 'unico' }, original).corpo, { exigeTamanho: false, tamanhos: [] });
    assert.equal(formulario.camposDoMaterial({ ...MATERIAL, tamanhos: [] }).campos.grade, '');
  });

  test('tamanhos da entrada: com grade, só a grade e na ordem dela; sem grade, a lista de antes (lotes, sugestões do tipo e padrão)', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.tamanhosDaEntrada([{ tamanho: '47' }], 'Sapatão / Botina', ['40', '38']), ['40', '38']);
    assert.deepEqual(formulario.tamanhosDaEntrada([{ tamanho: '47' }], 'Sapatão / Botina', []), formulario.tamanhosDaEntrada([{ tamanho: '47' }], 'Sapatão / Botina'));
  });

  test('mensagens próprias da grade, sem repetir o texto do servidor', () => {
    const { mensagens } = carregarMateriais();
    const r = (status, corpo) => ({ ok: false, status, ...corpo });
    assert.match(mensagens.erroEdicao(r(409, { codigo: 'MATERIAL_GRADE_TAMANHO_EM_USO', mensagem: 'SEGREDO' })), /saldo em estoque, mínimo próprio ou solicitação em aberto/);
    assert.match(mensagens.erroEdicao(r(409, { codigo: 'MATERIAL_TAMANHO_GRADE_INCOMPATIVEL', mensagem: 'SEGREDO' })), /grade/);
    assert.match(mensagens.erroCadastro(r(400, { codigo: 'VALIDACAO', detalhes: [{ campo: 'body.tamanhos.1', codigo: 'TAMANHO_REPETIDO' }] })), /repetido/);
    assert.match(mensagens.erroCadastro(r(400, { codigo: 'VALIDACAO', detalhes: [{ campo: 'body.tamanhos', codigo: 'GRADE_NAO_SE_APLICA' }] })), /tamanho único/);
    assert.match(mensagens.erroEntrada(r(400, { codigo: 'VALIDACAO', detalhes: [{ campo: 'body.tamanho', codigo: 'TAMANHO_FORA_DA_GRADE' }] })), /grade/);
    for (const texto of [mensagens.erroEdicao(r(409, { codigo: 'MATERIAL_GRADE_TAMANHO_EM_USO', mensagem: 'SEGREDO' }))]) assert.equal(/SEGREDO/.test(texto), false);
  });
});

describe('12G-8 — grade de tamanhos: tela de Materiais', () => {
  const html = ler('pages/materials.html');
  const marcacao = html.slice(0, html.lastIndexOf('<script>'));
  const opcoes = (innerHTML) => [...innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);

  test('estrutura: o campo da grade vem logo depois do controle de tamanho, oculto até "Possui tamanhos", com orientação de uso', () => {
    assert.match(marcacao, /id="materialControleTamanho"[\s\S]*?<\/div>\s*<\/div>\s*<div class="field full" id="campoGradeTamanhos" style="display:none">\s*<label for="materialGrade">Grade de tamanhos<\/label>\s*<input id="materialGrade" class="input" type="text"/);
    assert.match(marcacao, /separados por vírgula/);
    assert.match(marcacao, /Em branco: material sem grade definida/);
  });

  test('o campo aparece só com "Possui tamanhos"; a entrada inicial oferece os tamanhos da grade digitada', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    pg.el('materialControleTamanho').value = 'grade';
    await pg.disparar('materialControleTamanho', 'change');
    assert.equal(pg.el('campoGradeTamanhos').style.display, '');
    pg.el('materialGrade').value = '40, 38';
    await pg.disparar('materialGrade', 'input');
    assert.deepEqual(opcoes(pg.el('materialTamanhoEntrada').innerHTML), ['40', '38']);
    pg.el('materialControleTamanho').value = 'unico';
    await pg.disparar('materialControleTamanho', 'change');
    assert.equal(pg.el('campoGradeTamanhos').style.display, 'none');
  });

  test('cadastro com grade: o POST leva a grade na ordem digitada', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher({ ...FORMULARIO_DOM, materialRegistrarEntrada: 'nao', materialGrade: '39, 40, 41' });
    await pg.disparar('botaoSalvar');
    const post = chamadas.find((c) => c.metodo === 'POST' && c.caminho === '/api/materiais');
    assert.deepEqual(post.corpo.tamanhos, ['39', '40', '41']);
  });

  test('edição: o formulário mostra a grade gravada; mudar a grade envia só ela; recusa por tamanho em uso mostra a explicação', async () => {
    const comGrade = { ...MATERIAL, tamanhos: ['P', 'M'] };
    servidorRotas(estadoPadrao({
      materiais: [comGrade], buscar: (id) => resposta(200, { status: 'ok', material: { ...comGrade, id } }),
      alterar: () => resposta(409, { status: 'erro', codigo: 'MATERIAL_GRADE_TAMANHO_EM_USO', mensagem: 'SEGREDO' }),
    }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    assert.equal(pg.el('materialGrade').value, 'P, M');
    pg.preencher({ materialGrade: 'P' });
    await pg.disparar('botaoSalvar');
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'PATCH').map((c) => c.corpo), [{ tamanhos: ['P'] }]);
    assert.match(pg.el('aviso').innerHTML, /saldo em estoque, mínimo próprio ou solicitação em aberto/);
    assert.equal(/SEGREDO/.test(pg.el('aviso').innerHTML), false);
  });

  test('entrada no estoque por lote: material com grade oferece só a grade; tamanho com marcação aparece escapado', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], materialEstoque: { tamanhos: ['40', '<img src=x>'] } }));
    const pg = montarPagina();
    await pg.esperar();
    pg.el('gradeMaterial').value = '77';
    await pg.disparar('gradeMaterial', 'change');
    const html = pg.el('entradaTamanho').innerHTML;
    assert.deepEqual(opcoes(html), ['40', '&lt;img src=x&gt;']);
    assert.equal(/<img/.test(html), false);
  });

  test('material antigo sem grade: a entrada continua com a lista de antes', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], materialEstoque: { tamanhos: [] } }));
    const pg = montarPagina();
    await pg.esperar();
    pg.el('gradeMaterial').value = '77';
    await pg.disparar('gradeMaterial', 'change');
    assert.ok(opcoes(pg.el('entradaTamanho').innerHTML).length > 10, 'lista padrão de tamanhos');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 12G-8 — Categoria → Tipo: listas oficiais por categoria, "Outros" com
// descrição própria (tipo = "Outros", tipoDescricao = texto), legado fora das
// listas e os dois tipos de óculos. O backend confere tudo de novo.
// ───────────────────────────────────────────────────────────────────────────

const LISTA_EPI = [
  'Botina de Segurança', 'Capacete', 'Creme de Proteção', 'Luva', 'Mangote', 'Óculos de Proteção Ampla Visão',
  'Óculos de Proteção Incolor', 'Outros', 'Palmilha', 'Proteção Auricular Concha', 'Proteção Auricular Descartável',
  'Respirador PFF2', 'Sapato de Segurança', 'Viseira Película Ouro',
];
const LISTA_UNIFORME = ['Calça', 'Calça de Forneiro', 'Calça Eletricista', 'Camisa', 'Camisa de Forneiro', 'Camisa Eletricista', 'Camiseta', 'Outros'];
const OPCOES_TIPO = (html) => [...String(html).matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]).slice(1);

describe('12G-8 — Categoria → Tipo: módulo', () => {
  const F = () => carregarMateriais().formulario;
  const R = () => carregarMateriais().render;
  const ordenado = (lista) => [...lista].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const base = (extra = {}) => ({
    nome: 'Item', categoria: 'EPI', tipo: 'Luva', tipoCustom: '', fabricante: '', codigoInterno: '', unidade: 'Unidade', estoqueMinimo: '0',
    prazoUnidade: 'meses', prazo: '6', controleTamanho: 'unico', descricao: '', registrarEntrada: 'nao', quantidadeComprada: '', tamanhoEntrada: '',
    caEntrada: '', caValidadeEntrada: '', ...extra,
  });
  const salvo = (extra = {}) => ({
    id: 7, nome: 'Item', categoria: 'EPI', tipo: 'Luva', tipoDescricao: null, prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade',
    estoqueMinimo: 0, oculosComGrau: null, fabricante: null, codigoInterno: null, descricao: null, tamanhos: [], ...extra,
  });
  const campos = (m, extra = {}) => ({ ...F().camposDoMaterial(m).campos, ...extra });
  const erros = (r) => (r.ok ? [] : r.erros.map((e) => e.campo));

  test('listas oficiais por categoria, em ordem alfabética, sem cruzar tipos; as mesmas do backend', () => {
    assert.equal(F().OUTROS, 'Outros');
    assert.deepEqual(F().TIPOS_POR_CATEGORIA.EPI, LISTA_EPI);
    assert.deepEqual(F().TIPOS_POR_CATEGORIA.Uniforme, LISTA_UNIFORME);
    assert.deepEqual(F().TIPOS_POR_CATEGORIA['Material de consumo'], ['Outros']);
    assert.deepEqual(F().TIPOS_POR_CATEGORIA.Ferramenta, ['Outros']);
    assert.deepEqual(ordenado(LISTA_EPI), LISTA_EPI);
    assert.deepEqual(ordenado(LISTA_UNIFORME), LISTA_UNIFORME);
    for (const t of LISTA_UNIFORME) if (t !== 'Outros') assert.equal(LISTA_EPI.includes(t), false, t);
    for (const t of ['Sapatão / Botina', 'Protetor auricular', 'Respirador', 'Óculos de proteção', 'Outro']) assert.equal(LISTA_EPI.includes(t), false, t);
    assert.deepEqual(F().tiposDe('EPI'), LISTA_EPI);
    assert.deepEqual(F().tiposDe('Uniforme'), LISTA_UNIFORME);
    for (const c of ['Material de consumo', 'Ferramenta', '', null, undefined, 'Brinde', '__proto__']) assert.deepEqual(F().tiposDe(c), ['Outros'], String(c));
    const backend = require('../../backend/src/utils/classificacao-material');
    assert.deepEqual(F().TIPOS_POR_CATEGORIA, backend.TIPOS_POR_CATEGORIA);
    assert.deepEqual([F().TIPOS_OCULOS, F().TIPO_OCULOS_LEGADO, F().OUTROS], [backend.TIPOS_OCULOS, backend.TIPO_OCULOS_LEGADO, backend.OUTROS]);
  });

  test('cadastro: o tipo tem de ser da lista da categoria; vazio é recusado', () => {
    assert.deepEqual(erros(F().montarCorpo(base({ categoria: 'Uniforme', tipo: 'Luva' }))), ['tipo']);
    assert.deepEqual(erros(F().montarCorpo(base({ categoria: 'EPI', tipo: 'Sapatão / Botina' }))), ['tipo']);
    assert.deepEqual(erros(F().montarCorpo(base({ categoria: 'EPI', tipo: 'Óculos de proteção' }))), ['tipo']);
    assert.deepEqual(erros(F().montarCorpo(base({ categoria: 'Material de consumo', tipo: 'Luva' }))), ['tipo']);
    assert.deepEqual(erros(F().montarCorpo(base({ tipo: '' }))), ['tipo']);
    const ok = F().montarCorpo(base({ categoria: 'Uniforme', tipo: 'Camisa de Forneiro' }));
    assert.deepEqual([ok.ok, ok.corpo.categoria, ok.corpo.tipo, 'tipoDescricao' in ok.corpo], [true, 'Uniforme', 'Camisa de Forneiro', false]);
  });

  test('"Outros": tipo vai como "Outros" e a descrição à parte, aparada e limitada; sem descrição é erro no campo dela; texto puro', () => {
    const ok = F().montarCorpo(base({ categoria: 'Material de consumo', tipo: 'Outros', tipoCustom: '  Fita isolante  ' }));
    assert.deepEqual([ok.corpo.tipo, ok.corpo.tipoDescricao], ['Outros', 'Fita isolante']);
    assert.deepEqual(erros(F().montarCorpo(base({ categoria: 'EPI', tipo: 'Outros', tipoCustom: '   ' }))), ['tipoDescricao']);
    assert.deepEqual(erros(F().montarCorpo(base({ categoria: 'Uniforme', tipo: 'Outros', tipoCustom: 'x'.repeat(101) }))), ['tipoDescricao']);
    assert.equal('tipoDescricao' in F().montarCorpo(base({ categoria: 'EPI', tipo: 'Luva', tipoCustom: 'texto esquecido' })).corpo, false, 'tipo normal nunca leva descrição');
    const xss = F().montarCorpo(base({ categoria: 'Ferramenta', tipo: 'Outros', tipoCustom: '<img src=x onerror=alert(1)>' }));
    assert.equal(xss.corpo.tipoDescricao, '<img src=x onerror=alert(1)>', 'texto puro: quem escapa é a renderização');
  });

  test('edição carrega: tipo da lista; "Outros" com a descrição; legado fora da lista como "Outros" + descrição; óculos legado como opção temporária', () => {
    const lista = F().camposDoMaterial(salvo({ tipo: 'Capacete' }));
    assert.deepEqual([lista.campos.tipo, lista.campos.tipoCustom, lista.opcoesExtras.tipo], ['Capacete', '', null]);
    const outros = F().camposDoMaterial(salvo({ tipo: 'Outros', tipoDescricao: 'Perneira' }));
    assert.deepEqual([outros.campos.tipo, outros.campos.tipoCustom, outros.opcoesExtras.tipo], ['Outros', 'Perneira', null]);
    const legado = F().camposDoMaterial(salvo({ tipo: 'Sapatão / Botina' }));
    assert.deepEqual([legado.campos.tipo, legado.campos.tipoCustom, legado.opcoesExtras.tipo], ['Outros', 'Sapatão / Botina', null]);
    const oculos = F().camposDoMaterial(salvo({ tipo: 'Óculos de proteção', oculosComGrau: true }));
    assert.deepEqual([oculos.campos.tipo, oculos.campos.tipoCustom], ['Óculos de proteção', '']);
    assert.deepEqual(oculos.opcoesExtras.tipo, { valor: 'Óculos de proteção', rotulo: 'Óculos de proteção (legado)' });
    assert.deepEqual(F().camposDoMaterial(salvo({ tipo: null })).campos.tipo, '');
  });

  test('edição envia: o legado vira "Outros" + descrição ao salvar; sair de "Outros" limpa a descrição; só a descrição também muda; legado intocado não vai', () => {
    const legado = salvo({ tipo: 'Sapatão / Botina' });
    assert.deepEqual(F().montarEdicao(campos(legado, { nome: 'Botina nova' }), legado).corpo, { nome: 'Botina nova', tipo: 'Outros', tipoDescricao: 'Sapatão / Botina' });
    const outros = salvo({ tipo: 'Outros', tipoDescricao: 'Perneira' });
    assert.equal(F().montarEdicao(campos(outros), outros).alterado, false);
    assert.deepEqual(F().montarEdicao(campos(outros, { tipo: 'Luva', tipoCustom: 'Perneira' }), outros).corpo, { tipo: 'Luva', tipoDescricao: null });
    assert.deepEqual(F().montarEdicao(campos(outros, { tipoCustom: 'Perneira de raspa' }), outros).corpo, { tipoDescricao: 'Perneira de raspa' });
    assert.deepEqual(erros(F().montarEdicao(campos(outros, { tipoCustom: '' }), outros)), ['tipoDescricao']);
    const oculos = salvo({ tipo: 'Óculos de proteção', oculosComGrau: true });
    assert.equal(F().montarEdicao(campos(oculos), oculos).alterado, false);
    assert.deepEqual(F().montarEdicao(campos(oculos, { nome: 'Óculos novo' }), oculos).corpo, { nome: 'Óculos novo' });
    assert.deepEqual(F().montarEdicao(campos(oculos, { tipo: 'Óculos de Proteção Incolor' }), oculos).corpo, { tipo: 'Óculos de Proteção Incolor' });
    const semTipo = salvo({ tipo: null });
    assert.deepEqual(F().montarEdicao(campos(semTipo, { nome: 'Novo' }), semTipo).corpo, { nome: 'Novo' });
    assert.deepEqual(erros(F().montarEdicao(campos(semTipo, { tipo: 'Camisa' }), semTipo)), ['tipo'], 'Camisa não é tipo de EPI');
  });

  test('óculos: os dois tipos novos e o nome histórico são óculos; "Outros" com texto de óculos não é; calçados novos sugerem numeração', () => {
    assert.deepEqual(F().TIPOS_OCULOS, ['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão']);
    assert.equal(F().TIPO_OCULOS_LEGADO, 'Óculos de proteção');
    for (const t of ['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão', 'Óculos de proteção', ' Óculos de Proteção Incolor ']) assert.equal(F().ehOculos(t), true, t);
    for (const t of ['Outros', 'óculos de proteção incolor', 'Óculos', 'Luva', '', null]) assert.equal(F().ehOculos(t), false, String(t));
    const corpo = F().montarCorpo(base({ tipo: 'Óculos de Proteção Ampla Visão', oculosComGrau: true })).corpo;
    assert.deepEqual([corpo.tipo, corpo.oculosComGrau], ['Óculos de Proteção Ampla Visão', true]);
    assert.equal('oculosComGrau' in F().montarCorpo(base({ categoria: 'Material de consumo', tipo: 'Outros', tipoCustom: 'Óculos de proteção' })).corpo, false);
    for (const t of ['Botina de Segurança', 'Sapato de Segurança', 'Sapatão / Botina']) assert.deepEqual(F().tamanhosSugeridos(t), F().TAMANHOS_GRADE.slice(0, 11), t);
  });

  test('render.opcoesTipos: placeholder vazio, só os tipos da categoria, a opção legada quando houver, tudo escapado', () => {
    const html = R().opcoesTipos('Uniforme');
    assert.ok(String(html).startsWith('<option value="">Selecione</option>'), html);
    assert.deepEqual(OPCOES_TIPO(html), LISTA_UNIFORME);
    assert.equal(/Luva|Capacete/.test(html), false);
    const comLegado = R().opcoesTipos('EPI', { valor: 'Óculos de proteção', rotulo: 'Óculos de proteção (legado)' });
    assert.match(comLegado, /<option value="Óculos de proteção">Óculos de proteção \(legado\)<\/option>/);
    assert.deepEqual(OPCOES_TIPO(comLegado).slice(0, -1), LISTA_EPI);
    const xss = R().opcoesTipos('EPI', { valor: '"><script>alert(1)</script>', rotulo: '<img src=x onerror=alert(1)>' });
    assert.equal(/<script>|<img/.test(xss), false);
    assert.match(xss, /&lt;script&gt;/);
  });
});

describe('12G-8 — Categoria → Tipo: tela de Materiais', () => {
  const html = ler('pages/materials.html');
  const valores = (pg) => OPCOES_TIPO(pg.el('materialTipo').innerHTML);
  const DOM_OUTROS = {
    materialNome: 'Fita isolante', materialCategoria: 'Material de consumo', materialTipo: 'Outros', materialTipoCustom: '  Fita isolante  ', materialUnidade: 'Unidade',
    materialEstoqueMinimo: '0', materialValidadeTipo: 'meses', materialPrazo: '6', materialControleTamanho: 'unico', materialRegistrarEntrada: 'nao',
  };

  test('o HTML não traz lista fixa de tipos (só o placeholder); o campo da descrição chama-se "Descrição do tipo"', () => {
    const inicio = html.indexOf('<select id="materialTipo"');
    const select = html.slice(inicio, html.indexOf('</select>', inicio));
    assert.deepEqual([...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ['Selecione']);
    assert.match(html, /<label for="materialTipoCustom">Descrição do tipo<\/label>/);
    assert.equal(/<option>Sapatão \/ Botina<\/option>|<option>Outro<\/option>|Exemplos de tipos/.test(html), false);
  });

  test('ao trocar a categoria: lista da nova categoria; tipo e descrição SEMPRE limpos, mesmo "Outros" (a pessoa escolhe de novo)', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.el('materialCategoria').value = 'EPI';
    await pg.disparar('materialCategoria', 'change');
    assert.deepEqual(valores(pg), LISTA_EPI);
    pg.el('materialTipo').value = 'Botina de Segurança';
    await pg.disparar('materialTipo', 'change');
    pg.el('materialCategoria').value = 'Uniforme';
    await pg.disparar('materialCategoria', 'change');
    assert.deepEqual([valores(pg), pg.el('materialTipo').value, pg.el('customMaterialTypeField').style.display], [LISTA_UNIFORME, '', 'none']);
    pg.el('materialTipo').value = 'Outros';
    await pg.disparar('materialTipo', 'change');
    pg.el('materialTipoCustom').value = 'Colete refletivo';
    pg.el('materialCategoria').value = 'Material de consumo';
    await pg.disparar('materialCategoria', 'change');
    // Decisão de 04/10/2026: "Outros" e a descrição não sobrevivem à troca, mesmo existindo na nova categoria.
    assert.deepEqual([valores(pg), pg.el('materialTipo').value, pg.el('materialTipoCustom').value, pg.el('customMaterialTypeField').style.display], [['Outros'], '', '', 'none']);
    pg.el('materialCategoria').value = 'EPI';
    await pg.disparar('materialCategoria', 'change');
    pg.el('materialTipo').value = 'Luva';
    await pg.disparar('materialTipo', 'change');
    assert.deepEqual([pg.el('materialTipo').value, pg.el('materialTipoCustom').value, pg.el('customMaterialTypeField').style.display], ['Luva', '', 'none']);
  });

  test('na edição, trocar a categoria também limpa tipo e descrição, inclusive de um "Outros" gravado', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL, categoria: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Chave de fenda', id } }) }));
    const pg = montarPagina({ permissoes: PODE_EDITAR });
    await pg.esperar();
    await escolherMaterial(pg);
    await pg.disparar('botaoEditarMaterial');
    assert.deepEqual([pg.el('materialTipo').value, pg.el('materialTipoCustom').value], ['Outros', 'Chave de fenda']);
    pg.el('materialCategoria').value = 'Uniforme';
    await pg.disparar('materialCategoria', 'change');
    assert.deepEqual([valores(pg), pg.el('materialTipo').value, pg.el('materialTipoCustom').value, pg.el('customMaterialTypeField').style.display], [LISTA_UNIFORME, '', '', 'none']);
  });

  test('cadastro envia categoria, tipo "Outros" e a descrição aparada; sem descrição nada é enviado e o campo é marcado', async () => {
    servidorRotas(estadoPadrao({ proximoId: 93 }));
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(DOM_OUTROS);
    await pg.disparar('materialTipo', 'change');
    await pg.disparar('botaoSalvar');
    const [material, ...resto] = escritas();
    assert.deepEqual([material.caminho, resto.length], ['/api/materiais', 0]);
    assert.deepEqual([material.corpo.categoria, material.corpo.tipo, material.corpo.tipoDescricao], ['Material de consumo', 'Outros', 'Fita isolante']);

    servidorRotas(estadoPadrao());
    const sem = montarPagina();
    await sem.esperar();
    sem.preencher({ ...DOM_OUTROS, materialTipoCustom: '' });
    await sem.disparar('materialTipo', 'change');
    await sem.disparar('botaoSalvar');
    assert.equal(escritas().length, 0);
    assert.equal(sem.el('materialTipoCustom').atributos['aria-invalid'], 'true');
  });

  test('edição: tipo da lista vem selecionado; legado fora da lista vem como "Outros" + descrição; óculos legado vem como opção legada e mantém a caixa do grau', async () => {
    const editar = async (salvoExtra) => {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL, ...salvoExtra, id } }) }));
      const pg = montarPagina({ permissoes: PODE_EDITAR });
      await pg.esperar();
      await escolherMaterial(pg);
      await pg.disparar('botaoEditarMaterial');
      return pg;
    };
    const lista = await editar({ categoria: 'Uniforme', tipo: 'Camiseta', tipoDescricao: null });
    assert.deepEqual([valores(lista), lista.el('materialTipo').value, lista.el('customMaterialTypeField').style.display], [LISTA_UNIFORME, 'Camiseta', 'none']);
    const outros = await editar({ categoria: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Chave de fenda' });
    assert.deepEqual([valores(outros), outros.el('materialTipo').value, outros.el('materialTipoCustom').value, outros.el('customMaterialTypeField').style.display], [['Outros'], 'Outros', 'Chave de fenda', '']);
    const legado = await editar({ categoria: 'EPI', tipo: 'Sapatão / Botina', tipoDescricao: null });
    assert.deepEqual([legado.el('materialTipo').value, legado.el('materialTipoCustom').value, legado.el('customMaterialTypeField').style.display], ['Outros', 'Sapatão / Botina', '']);
    const oculos = await editar({ categoria: 'EPI', tipo: 'Óculos de proteção', tipoDescricao: null, oculosComGrau: true, exigeTamanho: false });
    assert.deepEqual([oculos.el('materialTipo').value, valores(oculos).at(-1), oculos.el('campoOculosComGrau').style.display, oculos.el('materialOculosComGrau').checked], ['Óculos de proteção', 'Óculos de proteção', '', true]);
    assert.match(oculos.el('materialTipo').innerHTML, /\(legado\)/);
  });

  test('"Limpar" não escolhe tipo nenhum sozinho', async () => {
    servidorRotas(estadoPadrao());
    const pg = montarPagina();
    await pg.esperar();
    pg.el('materialCategoria').value = 'EPI';
    await pg.disparar('materialCategoria', 'change');
    pg.el('materialTipo').value = 'Luva';
    await pg.disparar('botaoLimpar');
    assert.equal(pg.el('materialTipo').value, '');
  });
});
