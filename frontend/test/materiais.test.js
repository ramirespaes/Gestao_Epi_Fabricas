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
  id: 77, empresaId: 3, nome: 'Botina de segurança', tipo: 'Sapatão / Botina', fabricante: 'Bracol',
  caNumero: '38271', caValidade: '2027-01-31', prazoUsoDias: 180, unidade: 'par', estoqueMinimo: 5,
  categoria: 'EPI', codigoInterno: 'EPI-000245', descricao: 'Biqueira de composite', ativo: true,
};

const FORMULARIO = {
  nome: '  Botina de segurança  ', categoria: 'EPI', tipo: 'Sapatão / Botina', tipoCustom: '',
  caNumero: ' 38271 ', caValidade: '2027-01-31', fabricante: 'Bracol', codigoInterno: ' EPI-000245 ',
  quantidadeComprada: '120', tamanhoEntrada: '42', unidade: 'Par', estoqueMinimo: '5',
  definePrazo: 'sim', prazoUnidade: 'meses', prazo: '6', descricao: 'Biqueira de composite', registrarEntrada: 'sim',
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
  test('todos os campos: trim, tipo da lista, unidade em minúsculas, prazo em dias, três campos da 039; a quantidade comprada vira entrada separada', () => {
    const { formulario } = carregarMateriais();
    const r = formulario.montarCorpo(FORMULARIO);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.corpo, {
      nome: 'Botina de segurança', categoria: 'EPI', tipo: 'Sapatão / Botina', caNumero: '38271', caValidade: '2027-01-31',
      fabricante: 'Bracol', codigoInterno: 'EPI-000245', unidade: 'par', estoqueMinimo: 5, prazoUsoDias: 180, descricao: 'Biqueira de composite',
    });
    assert.deepEqual(r.entrada, { tamanho: '42', quantidade: 120 });
    assert.equal('quantidadeComprada' in r.corpo, false, 'nunca é atributo do material');
    assert.equal('empresaId' in r.corpo, false, 'a empresa vem da sessão');
  });

  test('tipo "Outro" envia o texto do campo livre; "Outro" sem texto é erro do campo tipo', () => {
    const { formulario } = carregarMateriais();
    const ok = formulario.montarCorpo({ ...FORMULARIO, tipo: 'Outro', tipoCustom: '  Perneira  ' });
    assert.equal(ok.corpo.tipo, 'Perneira');
    const erro = formulario.montarCorpo({ ...FORMULARIO, tipo: 'Outro', tipoCustom: '   ' });
    assert.deepEqual([erro.ok, erro.erros.map((e) => e.campo)], [false, ['tipo']]);
  });

  test('opcionais vazios são omitidos (o servidor grava NULL); "não define prazo" omite prazoUsoDias; sem quantidade não há entrada', () => {
    const { formulario } = carregarMateriais();
    const r = formulario.montarCorpo({
      nome: 'Luva', categoria: '', tipo: 'Luva', tipoCustom: '', caNumero: '', caValidade: '', fabricante: '  ', codigoInterno: '',
      quantidadeComprada: '', tamanhoEntrada: '', unidade: 'Unidade', estoqueMinimo: '', definePrazo: 'nao', prazoUnidade: 'meses', prazo: '6', descricao: '',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.corpo, { nome: 'Luva', tipo: 'Luva', unidade: 'unidade' });
    assert.equal(r.entrada, null);
  });

  test('erros por campo: nome vazio, prazo inválido quando "sim", estoque mínimo negativo, quantidade sem tamanho, quantidade não inteira, data inválida, limites de tamanho', () => {
    const { formulario } = carregarMateriais();
    const campos = (r) => r.erros.map((e) => e.campo).sort();
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, nome: '   ' })), ['nome']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, prazo: '0' })), ['prazo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, prazo: '' })), ['prazo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, estoqueMinimo: '-1' })), ['estoqueMinimo']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, tamanhoEntrada: '' })), ['tamanhoEntrada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '1.5' })), ['quantidadeComprada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '-2' })), ['quantidadeComprada']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, caValidade: '31/01/2027' })), ['caValidade']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, nome: 'x'.repeat(151) })), ['nome']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, codigoInterno: 'x'.repeat(31) })), ['codigoInterno']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, categoria: 'x'.repeat(31) })), ['categoria']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, descricao: 'x'.repeat(501) })), ['descricao']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, caNumero: 'x'.repeat(21) })), ['caNumero']);
    assert.deepEqual(campos(formulario.montarCorpo({ ...FORMULARIO, tamanhoEntrada: 'x'.repeat(21) })), ['tamanhoEntrada']);
    const varios = formulario.montarCorpo({ ...FORMULARIO, nome: '', prazo: 'abc', tamanhoEntrada: '' });
    assert.deepEqual([varios.ok, campos(varios)], [false, ['nome', 'prazo', 'tamanhoEntrada']]);
    assert.equal(varios.corpo, undefined, 'com erro nada é enviado');
  });

  test('tamanhos sugeridos por tipo: calçado 34–44, luva PP–GG, demais "Único"; a grade completa tem os 17 chips originais', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.tamanhosSugeridos('Sapatão / Botina'), ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44']);
    assert.deepEqual(formulario.tamanhosSugeridos('Luva'), ['PP', 'P', 'M', 'G', 'GG']);
    assert.deepEqual(formulario.tamanhosSugeridos('Capacete'), ['Único']);
    assert.deepEqual(formulario.tamanhosSugeridos('Perneira de raspa'), ['Único']);
    assert.deepEqual(formulario.tamanhosSugeridos(''), ['Único']);
    assert.deepEqual(formulario.TAMANHOS_GRADE, ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', 'Único', 'PP', 'P', 'M', 'G', 'GG']);
  });
});

describe('grade: saldo real por tamanho, com quatro estados distintos', () => {
  test('0 → sem estoque; abaixo do mínimo → atenção; no mínimo ou acima → com saldo; sem mínimo, qualquer saldo positivo é com saldo', () => {
    const { grade } = carregarMateriais();
    assert.equal(grade.situacao(0, 5), 'sem-estoque');
    assert.equal(grade.situacao(3, 5), 'abaixo-minimo');
    assert.equal(grade.situacao(5, 5), 'com-saldo');
    assert.equal(grade.situacao(12, 5), 'com-saldo');
    assert.equal(grade.situacao(1, 0), 'com-saldo');
    assert.deepEqual([grade.classeChip('sem-estoque'), grade.classeChip('abaixo-minimo'), grade.classeChip('com-saldo')], ['chip-empty', 'chip-warning', 'chip-ok']);
  });

  test('chips = tamanhos sugeridos pelo tipo + tamanhos com saldo no banco (nenhum saldo inventado: ausente = 0)', () => {
    const { grade } = carregarMateriais();
    const saldos = [{ tamanho: '42', quantidade: 12 }, { tamanho: '43', quantidade: 3 }, { tamanho: '47', quantidade: 2 }];
    const chips = grade.montar(saldos, 5, ['41', '42', '43']);
    assert.deepEqual(chips, [
      { tamanho: '41', quantidade: 0, situacao: 'sem-estoque' },
      { tamanho: '42', quantidade: 12, situacao: 'com-saldo' },
      { tamanho: '43', quantidade: 3, situacao: 'abaixo-minimo' },
      { tamanho: '47', quantidade: 2, situacao: 'abaixo-minimo' },
    ]);
    assert.equal(grade.resumo(chips), '2 disponível · 2 atenção · 1 em falta'.replace('2 disponível · 2 atenção', '1 disponível · 2 atenção'));
    assert.equal(grade.resumo([]), 'Nenhum saldo registrado');
  });

  test('render dos chips: somente leitura (sem onclick), classe pelo estado, título com a quantidade, tudo escapado', () => {
    const { grade, render } = carregarMateriais();
    const html = render.chips(grade.montar([{ tamanho: '<b>x</b>', quantidade: 2 }], 0, ['M']));
    assert.equal(/onclick/.test(html), false);
    assert.match(html, /class="size-chip chip-empty"[^>]*>M</);
    assert.match(html, /class="size-chip chip-ok"[^>]*title="2 em estoque"[^>]*>&lt;b&gt;x&lt;\/b&gt;</);
    assert.match(html, /disabled/);
  });

  test('falha na consulta é um estado próprio: nem "sem estoque" nem saldo', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroGrade({ ok: false, status: 0, codigo: null }), /rede/i);
    assert.match(mensagens.erroGrade({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /não pode consultar o estoque/i);
    assert.match(mensagens.erroGrade({ ok: false, status: 404, codigo: 'MATERIAL_NAO_ENCONTRADO' }), /não encontrado nesta empresa/i);
    assert.match(mensagens.erroGrade({ ok: false, status: 500, codigo: 'ERRO_INTERNO' }), /Não foi possível consultar/i);
  });
});

describe('mensagens: cada código do backend vira texto claro, sem vazar o corpo', () => {
  test('cadastro: 403, 409 código duplicado, 400 VALIDACAO com os campos, rede, 401 exige novo login', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroCadastro({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /não pode cadastrar materiais nesta empresa/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 409, codigo: 'MATERIAL_CODIGO_INTERNO_DUPLICADO' }), /código interno/i);
    const validacao = mensagens.erroCadastro({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ caminho: 'caValidade', codigo: 'CA_VALIDADE_INVALIDA' }, { caminho: 'nome' }] });
    assert.match(validacao, /caValidade/);
    assert.match(validacao, /nome/);
    assert.match(mensagens.erroCadastro({ ok: false, status: 0, codigo: null }), /rede/i);
    // correção 4 da auditoria: 5xx não é recusa — resultado não confirmado; a mensagem genérica fica para 4xx sem código próprio
    assert.match(mensagens.erroCadastro({ ok: false, status: 500, codigo: 'ERRO_INTERNO' }), /não foi possível confirmar se o material foi cadastrado/i);
    assert.match(mensagens.erroCadastro({ ok: false, status: 422, codigo: 'OUTRO' }), /Não foi possível cadastrar/i);
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 401 }), true);
    assert.equal(mensagens.exigeNovoLogin({ ok: false, status: 403 }), false);
  });

  test('entrada inicial: 403 sem MOVIMENTAR_ESTOQUE, material inativo, limite, validação, rede; e o resultado combinado do cadastro', () => {
    const { mensagens } = carregarMateriais();
    assert.match(mensagens.erroEntrada({ ok: false, status: 403, codigo: 'SEM_PERMISSAO' }), /movimentar estoque/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 409, codigo: 'MATERIAL_INATIVO' }), /inativo/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 409, codigo: 'ESTOQUE_LIMITE_EXCEDIDO' }), /limite/i);
    assert.match(mensagens.erroEntrada({ ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ caminho: 'quantidade' }] }), /quantidade/);
    assert.match(mensagens.erroEntrada({ ok: false, status: 0 }), /rede/i);

    assert.equal(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: false } }), 'Material cadastrado com sucesso. Registrado sem quantidade em estoque: nenhuma entrada inicial foi feita.');
    assert.equal(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: true, saldo: { tamanho: '42', quantidade: 120 } } }),
      'Material cadastrado com sucesso. Entrada de estoque registrada: 120 no tamanho 42.');
    const semPermissao = mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'SEM_PERMISSAO' } });
    assert.match(semPermissao, /^Material cadastrado com sucesso\. Entrada de estoque não realizada: /);
    assert.match(semPermissao, /movimentar estoque/i);
    const recusada = mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'RECUSADA', resposta: { ok: false, status: 409, codigo: 'ESTOQUE_LIMITE_EXCEDIDO' } } });
    assert.match(recusada, /^Material cadastrado com sucesso\. Entrada de estoque não realizada: /);
    assert.match(recusada, /limite/i);
  });
});

describe('fluxo: cadastro e entrada inicial são duas operações, na ordem certa, sem desfazer nem repetir', () => {
  const corpo = { nome: 'Botina', unidade: 'par' };
  const entrada = { tamanho: '42', quantidade: 120 };

  test('sem entrada: só POST /materiais', async () => {
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada: null, podeMovimentar: true });
    assert.deepEqual([r.ok, r.material.id, r.entrada.solicitada], [true, 77, false]);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais']);
    assert.deepEqual(chamadas[0].corpo, corpo);
  });

  test('com entrada e MOVIMENTAR_ESTOQUE: POST /materiais e DEPOIS POST /materiais/:id/estoque/movimentar (ENTRADA, tamanho, quantidade, motivo fixo)', async () => {
    servidor(resposta(201, { status: 'ok', material: MATERIAL }), resposta(200, { status: 'ok', saldo: { materialId: 77, tamanho: '42', quantidade: 120 } }));
    const { fluxo } = carregarMateriais();
    const r = await fluxo.cadastrar({ corpo, entrada, podeMovimentar: true });
    assert.deepEqual([r.ok, r.entrada.solicitada, r.entrada.realizada, r.entrada.motivo], [true, true, true, null]);
    assert.deepEqual(r.entrada.saldo, { materialId: 77, tamanho: '42', quantidade: 120 });
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais', 'POST /api/materiais/77/estoque/movimentar']);
    assert.deepEqual(chamadas[1].corpo, { tamanho: '42', tipo: 'ENTRADA', quantidade: 120, motivo: 'Entrada inicial do cadastro' });
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
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['POST /api/materiais', 'POST /api/materiais/77/estoque/movimentar']);
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

  test('grade: GET /materiais/:id/estoque vira chips e resumo com o mínimo do material; erro vira estado de falha', async () => {
    servidor(resposta(200, { status: 'ok', material: { ...MATERIAL, estoqueMinimo: 5 }, saldos: [{ tamanho: '42', quantidade: 12 }, { tamanho: '43', quantidade: 3 }] }));
    const { fluxo } = carregarMateriais();
    const r = await fluxo.carregarGrade(77);
    assert.equal(r.ok, true);
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['GET /api/materiais/77/estoque']);
    assert.deepEqual(r.chips.filter((c) => c.quantidade > 0), [{ tamanho: '42', quantidade: 12, situacao: 'com-saldo' }, { tamanho: '43', quantidade: 3, situacao: 'abaixo-minimo' }]);
    assert.ok(r.chips.some((c) => c.tamanho === '34' && c.situacao === 'sem-estoque'), 'sugeridos do tipo entram sem saldo');
    assert.equal(r.resumo, '1 disponível · 1 atenção · 9 em falta');

    servidor(resposta(404, { status: 'erro', codigo: 'MATERIAL_NAO_ENCONTRADO', mensagem: 'x' }));
    const falha = await fluxo.carregarGrade(999);
    assert.deepEqual([falha.ok, falha.resposta.status], [false, 404]);
  });

  test('lista de materiais para o seletor da grade: GET /materiais?ativo=true&limite=…, sem empresaId', async () => {
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
  const p = (visualizar, criar, movimentar) => ({
    recursos: { materials: { visualizar, criar, editar: false, excluir: false } },
    acoes: { MOVIMENTAR_ESTOQUE: movimentar },
    administracao: {},
  });

  test('abrir exige materials.visualizar; alterar exige materials.criar; movimentar é a ação MOVIMENTAR_ESTOQUE, independente', () => {
    assert.ok(P.PAGINAS.materials, 'entrada materials');
    assert.equal(P.podeAbrir(p(true, false, false), 'materials'), true);
    assert.equal(P.podeAlterar(p(true, false, false), 'materials'), false);
    assert.equal(P.podeAlterar(p(true, true, false), 'materials'), true);
    assert.equal(P.podeAbrir(p(false, true, true), 'materials'), false, 'criar sem visualizar não abre');
    assert.equal(P.podeAlterar(p(false, true, true), 'materials'), false);
    assert.equal(P.acao(p(true, true, true), 'MOVIMENTAR_ESTOQUE'), true);
    assert.equal(P.acao(p(true, true, false), 'MOVIMENTAR_ESTOQUE'), false);
    assert.equal(P.podeAbrir(null, 'materials'), false);
    assert.equal(P.podeAbrir({ recursos: { materials: { visualizar: 'true' } }, acoes: {}, administracao: {} }, 'materials'), false, 'só true explícito');
  });

  test('as quatro páginas administrativas da C1 continuam exatamente como aprovadas', () => {
    assert.deepEqual(P.PAGINAS['grupos-acesso'], { abrir: [['gruposAcesso', 'consultar']], alterar: [['gruposAcesso', 'alterar']] });
    assert.deepEqual(P.PAGINAS['grupo-permissoes'], { abrir: [['permissoesGrupo', 'consultar'], ['gruposAcesso', 'consultar']], alterar: [['permissoesGrupo', 'alterar']] });
    assert.deepEqual(P.PAGINAS['grupo-usuarios'], { abrir: [['vinculosGrupo', 'consultar'], ['gruposAcesso', 'consultar']], alterar: [['vinculosGrupo', 'alterar']] });
    assert.deepEqual(P.PAGINAS['autorizacoes-individuais'], { abrir: [['autorizacoesIndividuais', 'consultar']], alterar: [] });
  });

  test('menu: o link de materiais aparece só com visualizar; com permissões nulas fica oculto', () => {
    const link = { style: { display: '' }, getAttribute: (n) => (n === 'data-pagina' ? 'materials' : null) };
    P.aplicarMenu(p(false, false, false), [link]);
    assert.equal(link.style.display, 'none');
    P.aplicarMenu(p(true, false, false), [link]);
    assert.equal(link.style.display, '');
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
    for (const id of ['telaSessao', 'telaSessaoMensagem', 'telaSessaoPortal', 'identidade', 'botaoSair', 'botaoTrocarEmpresa', 'aviso']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/materiais.js']);
    assert.match(codigo, /EpiHttp\.configurar\(\{ baseUrl: window\.SAFEWORK_PORTAL_API_BASE_URL \}\)/);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
    assert.match(codigo, /aoFalharSaida: function \(mensagem\) \{ mostrarAviso\(mensagem, 'erro'\); \}/);
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'materials'/);
    assert.match(html, /SafeWork/);
  });

  test('todos os campos originais permanecem, com os acréscimos aprovados: Validade do CA, Tamanho da entrada inicial e seletor de material da grade', () => {
    for (const id of ['materialNome', 'materialCategoria', 'materialTipo', 'customMaterialTypeField', 'materialTipoCustom', 'materialCa', 'materialFabricante',
      'materialCodigo', 'materialQuantidadeComprada', 'materialUnidade', 'materialEstoqueMinimo', 'materialValidade', 'validityFields', 'materialValidadeTipo',
      'materialPrazo', 'materialPrazoLabel', 'materialPrazoHelper', 'materialPrazoPreview', 'materialPrazoPreviewText', 'materialDocumentoValidade', 'materialDesc',
      'sizeChipsGrid', 'stockSummaryText', 'materialCaValidade', 'materialTamanhoEntrada', 'gradeMaterial', 'botaoLimpar', 'botaoSalvar']) {
      assert.ok(ids.includes(id), `falta #${id}`);
    }
    assert.match(html, /<input id="materialCaValidade" class="input" type="date"/);
    assert.match(html, /<select id="materialTamanhoEntrada" class="select"/);
    assert.match(html, /<select id="gradeMaterial" class="select"/);
    assert.match(html, /<input id="materialDocumentoValidade" class="input" type="file"[^>]*disabled/);
    assert.match(html, /em desenvolvimento/i);
    for (const opcao of ['EPI', 'Uniforme', 'Ferramenta', 'Material de consumo', 'Sapatão / Botina', 'Óculos de proteção', 'Luva', 'Protetor auricular', 'Capacete', 'Respirador', 'Outro', 'Par', 'Unidade', 'Caixa', 'Pacote', 'Kit']) {
      assert.match(html, new RegExp(`<option[^>]*>${opcao.replace(/[/]/g, '\\/')}</option>`), `opção ${opcao}`);
    }
    assert.match(html, /<button id="botaoLimpar" class="outlined-btn" type="button">Limpar<\/button>/);
    assert.match(html, /<button id="botaoSalvar" class="filled-btn" type="button"[^>]*><span class="material-symbols-outlined">save<\/span>Salvar material<\/button>/);
    assert.match(html, /Exemplos de tipos/);
    assert.match(html, /Grade de tamanhos/);
    assert.equal(/Atualiza automaticamente ao lançar entradas em Compras/.test(html), false, 'texto do simulado substituído');
    assert.match(html, /Saldo real por tamanho/);
    assert.equal((html.match(/class="size-chip/g) || []).length, 0, 'os chips nascem vazios: só saldo real');
  });

  test('menu: estrutura original preservada; integrados com data-pagina ocultos; demais sem link e com "Em integração"; nenhum link para o protótipo', () => {
    for (const secao of ['Visão geral', 'Estoque', 'Entregas', 'Solicitações', 'Administração']) assert.match(html, new RegExp(`<div class="nav-section">${secao}</div>`));
    const links = [...html.matchAll(/<a [^>]*data-pagina="([^"]+)"[^>]*>/g)];
    assert.deepEqual(links.map((m) => m[1]).sort(), ['autorizacoes-individuais', 'availableItems', 'dashboard', 'employeeGroups', 'employeeHistory', 'grupo-permissoes', 'grupo-usuarios', 'grupos-acesso', 'importEmployees', 'materials']);
    for (const m of links) assert.match(m[0], /style="display:none"/, `${m[1]} deve nascer oculto`);
    assert.equal(/data-page=/.test(html), false, 'o mapa de arquivos do protótipo saiu');
    const pendentes = [...html.matchAll(/<a class="nav-pendente"[^>]*>[\s\S]*?<\/a>/g)];
    assert.ok(pendentes.length >= 16, `itens não integrados presentes (${pendentes.length})`);
    for (const m of pendentes) {
      assert.equal(/href=/.test(m[0]), false, 'não integrado não tem link');
      assert.match(m[0], /Em integração/);
    }
    for (const rotulo of ['Relatórios', 'Operações', 'Regras Função / Setor', 'Compras / Entradas', 'Validade do Estoque', 'Itens Disponíveis', 'EPIs Entregues', 'Ficha de EPI', 'Histórico de Funcionários', 'Autoatendimento (Totem)', 'Pedido de EPI', 'Aprovação do Supervisor', 'Sem Estoque', 'Importar Funcionários', 'Novo Usuário', 'Administração de Usuários', 'Configurações', 'Suporte', 'Gestão de E-mails', 'Privacidade / LGPD']) {
      assert.ok(html.includes(rotulo), `rótulo ${rotulo} preservado`);
    }
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('http') && !h.startsWith('../css/') && h !== 'javascript:void(0)');
    const permitidos = new Set(['available-items.html', 'dashboard.html', 'employee-groups.html', 'employee-history.html', 'import-employees.html', 'grupos-acesso.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'autorizacoes-individuais.html', '../portal/index.html', '../portal/inicio.html']);
    for (const h of hrefs) assert.ok(permitidos.has(h), `materials.html aponta para ${h}`);
    assert.match(html, /onclick="toggleSidebar\(\)"/);
    assert.match(html, /onclick="closeMobileMenu\(\)"/);
  });

  test('portal/inicio: Materiais e EPIs entra nos módulos integrados (oculto até a permissão) e sai da lista "Em integração"', () => {
    const inicio = ler('portal/inicio.html');
    assert.match(inicio, /<a href="\.\.\/pages\/materials\.html" data-pagina="materials" style="display:none">Materiais e EPIs<\/a>/);
    const emIntegracao = inicio.slice(inicio.indexOf('Em integração'));
    assert.equal(/Materiais e EPIs/.test(emIntegracao), false);
    assert.match(emIntegracao, /Estoque/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Correções da auditoria C2 (24/09/2026): mensagens preservadas após
// limpar, paginação do seletor, limites INTEGER no cliente e resultado
// não confirmado (rede / 5xx) distinto de recusa.
// ═══════════════════════════════════════════════════════════════════

const vm = require('node:vm');
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração SafeWork' }, usuario: { id: 7, nome: 'Pessoa', email: 'p@exemplo-cliente.com.br', perfil: 'MASTER' } };

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
    materiais: [], saldos: [], proximoId: 999,
    criar(corpo) { const m = { ...MATERIAL, ...corpo, id: e.proximoId }; return resposta(201, { status: 'ok', material: m }); },
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
function montarPagina({ permissoes = { recursos: { materials: { visualizar: true, criar: true, editar: false, excluir: false } }, acoes: { MOVIMENTAR_ESTOQUE: true }, administracao: {} }, podeAlterar = true } = {}) {
  const html = ler('pages/materials.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const SELECTS = new Set(['materialCategoria', 'materialTipo', 'materialUnidade', 'materialValidade', 'materialValidadeTipo', 'materialTamanhoEntrada', 'gradeMaterial', 'materialRegistrarEntrada', 'entradaTamanho']);
  const mapa = {};
  const elemento = (id) => {
    const listeners = {};
    return {
      id, value: '', textContent: '', innerHTML: '', disabled: false, selectedIndex: 0, style: {}, atributos: {}, listeners,
      tagName: SELECTS.has(id) ? 'SELECT' : 'INPUT',
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this.atributos[k] = v; }, removeAttribute(k) { delete this.atributos[k]; }, focus() {},
      querySelector() { return elemento('form-grid'); }, querySelectorAll() { return []; },
    };
  };
  const el = (id) => (mapa[id] = mapa[id] || elemento(id));
  const toasts = [];
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiMateriais: carregarMateriais(), EpiPermissoes: { prepararPagina: async () => ({ permissoes, podeAlterar }), acao: P.acao, recurso: P.recurso, somenteLeitura() {} },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    showToast: (m, t) => toasts.push([m, t]), toasts, console, setTimeout, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click') => { for (const fn of (el(id).listeners[ev] || [])) await fn(); await esperar(); };
  const preencher = (campos) => { for (const [id, v] of Object.entries(campos)) el(id).value = v; };
  return { el, sandbox, esperar, disparar, preencher };
}

const FORMULARIO_DOM = { materialNome: 'Botina nova', materialCategoria: 'EPI', materialTipo: 'Sapatão / Botina', materialCa: '1', materialUnidade: 'Par', materialEstoqueMinimo: '5', materialValidade: 'sim', materialValidadeTipo: 'meses', materialPrazo: '6', materialQuantidadeComprada: '10', materialTamanhoEntrada: '42', materialRegistrarEntrada: 'sim' };

describe('correção 1 — a mensagem do cadastro sobrevive à limpeza do formulário', () => {
  test('cadastro ok com entrada recusada (403): o formulário é limpo, mas o aviso "Entrada de estoque não realizada" permanece', async () => {
    const estado = estadoPadrao({ movimentar: () => resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO', mensagem: 'x' }) });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(FORMULARIO_DOM);
    await pg.disparar('botaoSalvar');
    assert.equal(pg.el('materialNome').value, '', 'formulário limpo');
    assert.equal(pg.el('aviso').style.display, 'block', 'aviso visível');
    assert.match(pg.el('aviso').innerHTML, /Material cadastrado com sucesso\. Entrada de estoque não realizada/);
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/api/materiais', '/api/materiais/999/estoque/movimentar']);
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
    assert.ok(chamadas.some((c) => c.caminho === '/api/materiais/999/estoque'), 'grade carregada para o novo material');
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
    assert.match(pg.el('aviso').innerHTML, /Quantidade comprada/);
  });
});

describe('correção 4 — resultado não confirmado (rede / 5xx) é diferente de recusa', () => {
  const corpo = { nome: 'Botina', unidade: 'par' };
  const entrada = { tamanho: '42', quantidade: 10 };

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

  test('mensagens: cadastro não confirmado orienta a conferir a lista antes de repetir; entrada não confirmada preserva a identificação do material e orienta a consultar o saldo real', () => {
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
    assert.match(texto, /Entrada de estoque não confirmada/);
    assert.match(texto, /saldo real/i);
    assert.equal(/não realizada/.test(texto), false, 'não confirmado não é "não realizada"');
    assert.match(mensagens.resultado({ ok: true, material: MATERIAL, entrada: { solicitada: true, realizada: false, motivo: 'RECUSADA', resposta: { ok: false, status: 403 } } }), /Entrada de estoque não realizada: /);
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

  test('página: entrada com 500 mostra a identificação do material e a orientação, e carrega a grade do material', async () => {
    const estado = estadoPadrao({ movimentar: () => resposta(500, { status: 'erro', codigo: 'ERRO_INTERNO' }) });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    pg.preencher(FORMULARIO_DOM);
    await pg.disparar('botaoSalvar');
    assert.equal(chamadas.filter((c) => /movimentar$/.test(c.caminho)).length, 1);
    assert.match(pg.el('aviso').innerHTML, /nº 999/);
    assert.match(pg.el('aviso').innerHTML, /Entrada de estoque não confirmada/);
    assert.equal(pg.el('gradeMaterial').value, '999');
    assert.ok(chamadas.some((c) => c.caminho === '/api/materiais/999/estoque'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Melhoria da C2 (25/09/2026): edição de material existente na mesma
// tela (GET/PATCH /materiais/:id, que já existem), entrada inicial só com
// "Sim" explícito, tamanho nunca escolhido automaticamente, unidade de
// controle bloqueada na edição e validade do CA preservada.
// ═══════════════════════════════════════════════════════════════════

const PERMISSOES_EDITAR = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { MOVIMENTAR_ESTOQUE: true }, administracao: {} };
const PERMISSOES_SO_EDITAR = { recursos: { materials: { visualizar: true, criar: false, editar: true, excluir: false } }, acoes: { MOVIMENTAR_ESTOQUE: true }, administracao: {} };
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
    assert.deepEqual(formulario.prazoParaCampos(null), { definePrazo: 'nao', prazoUnidade: 'meses', prazo: '' });
    assert.deepEqual(formulario.prazoParaCampos(365), { definePrazo: 'sim', prazoUnidade: 'anos', prazo: '1' });
    assert.deepEqual(formulario.prazoParaCampos(730), { definePrazo: 'sim', prazoUnidade: 'anos', prazo: '2' });
    assert.deepEqual(formulario.prazoParaCampos(180), { definePrazo: 'sim', prazoUnidade: 'meses', prazo: '6' });
    assert.deepEqual(formulario.prazoParaCampos(30), { definePrazo: 'sim', prazoUnidade: 'meses', prazo: '1' });
    assert.deepEqual(formulario.prazoParaCampos(45), { definePrazo: 'sim', prazoUnidade: 'dias', prazo: '45' });
    for (const dias of [1, 29, 30, 45, 180, 365, 400, 730, 10950]) {
      const c = formulario.prazoParaCampos(dias);
      assert.equal(formulario.converterPrazo(c.prazo, c.prazoUnidade), dias, `ida e volta de ${dias} dias`);
    }
  });

  test('validade do CA: 15/10/2026 continua 15/10/2026 no formulário (data pura ou data e hora em São Paulo ou UTC)', () => {
    const { formulario } = carregarMateriais();
    for (const v of ['2026-10-15', '2026-10-15T03:00:00.000Z', '2026-10-15T00:00:00.000Z']) {
      assert.equal(formulario.dataParaCampo(v), '2026-10-15', v);
    }
    for (const v of [null, undefined, '', '15/10/2026', 'lixo']) assert.equal(formulario.dataParaCampo(v), '', String(v));
    assert.equal(formulario.camposDoMaterial(MATERIAL_CA).campos.caValidade, '2026-10-15');
  });

  test('camposDoMaterial: preenche o formulário com o registro real; tipo fora da lista vira "Outro"; valores fora das listas ganham opção temporária, nunca trocados em silêncio', () => {
    const { formulario } = carregarMateriais();
    const r = formulario.camposDoMaterial(MATERIAL);
    assert.deepEqual(r.campos, {
      nome: 'Botina de segurança', categoria: 'EPI', tipo: 'Sapatão / Botina', tipoCustom: '', caNumero: '38271', caValidade: '2027-01-31',
      fabricante: 'Bracol', codigoInterno: 'EPI-000245', unidade: 'Par', estoqueMinimo: '5', definePrazo: 'sim', prazoUnidade: 'meses', prazo: '6',
      descricao: 'Biqueira de composite', registrarEntrada: 'nao', quantidadeComprada: '', tamanhoEntrada: '',
    });
    assert.deepEqual(r.opcoesExtras, { categoria: null, unidade: null });
    const outro = formulario.camposDoMaterial({ ...MATERIAL, tipo: 'Perneira', categoria: null, unidade: 'rolo', caNumero: null, caValidade: null, fabricante: null, codigoInterno: null, descricao: null, prazoUsoDias: null });
    assert.deepEqual([outro.campos.tipo, outro.campos.tipoCustom, outro.campos.categoria, outro.campos.unidade], ['Outro', 'Perneira', '', 'rolo']);
    assert.deepEqual([outro.campos.caNumero, outro.campos.caValidade, outro.campos.fabricante, outro.campos.codigoInterno, outro.campos.descricao, outro.campos.definePrazo], ['', '', '', '', '', 'nao']);
    assert.deepEqual(outro.opcoesExtras, { categoria: { valor: '', rotulo: 'Sem categoria' }, unidade: { valor: 'rolo', rotulo: 'rolo' } });
    assert.deepEqual(formulario.camposDoMaterial({ ...MATERIAL, tipo: null }).campos.tipo, 'Outro');
    assert.equal(formulario.camposDoMaterial({ ...MATERIAL, unidade: 'caixa' }).campos.unidade, 'Caixa');
    assert.deepEqual(formulario.camposDoMaterial({ ...MATERIAL, categoria: 'Químicos' }).opcoesExtras.categoria, { valor: 'Químicos', rotulo: 'Químicos' });
  });

  test('montarEdicao: nada alterado → nenhum campo; nome, CA, validade e fabricante alterados → PATCH só com esses quatro', () => {
    const { formulario } = carregarMateriais();
    const campos = formulario.camposDoMaterial(MATERIAL_CA).campos;
    assert.deepEqual(formulario.montarEdicao(campos, MATERIAL_CA), { ok: true, corpo: {}, alterado: false });
    const r = formulario.montarEdicao({ ...campos, nome: ' Botina nova ', caNumero: '40000', caValidade: '2028-03-01', fabricante: '3M' }, MATERIAL_CA);
    assert.deepEqual(r, { ok: true, corpo: { nome: 'Botina nova', caNumero: '40000', caValidade: '2028-03-01', fabricante: '3M' }, alterado: true });
  });

  test('montarEdicao: validade do CA recebida como data e hora e não tocada não é reenviada', () => {
    const { formulario } = carregarMateriais();
    const original = { ...MATERIAL, caValidade: '2026-10-15T03:00:00.000Z' };
    const r = formulario.montarEdicao(formulario.camposDoMaterial(original).campos, original);
    assert.deepEqual(r, { ok: true, corpo: {}, alterado: false });
  });

  test('montarEdicao: opcional apagado vai como null; prazo equivalente não é reenviado; "Não" no prazo limpa; novo prazo em dias', () => {
    const { formulario } = carregarMateriais();
    const campos = formulario.camposDoMaterial(MATERIAL).campos;
    const limpo = formulario.montarEdicao({ ...campos, caNumero: '', caValidade: '', fabricante: ' ', codigoInterno: '', descricao: '', categoria: '' }, MATERIAL);
    assert.deepEqual(limpo.corpo, { caNumero: null, caValidade: null, fabricante: null, codigoInterno: null, descricao: null, categoria: null });
    assert.equal(formulario.montarEdicao({ ...campos, prazoUnidade: 'dias', prazo: '180' }, MATERIAL).alterado, false, '180 dias = 6 meses: nada muda');
    assert.deepEqual(formulario.montarEdicao({ ...campos, definePrazo: 'nao' }, MATERIAL).corpo, { prazoUsoDias: null });
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
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, categoria: 'x'.repeat(31) }, MATERIAL)), ['categoria']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, caValidade: '15/10/2026' }, MATERIAL)), ['caValidade']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, prazo: '0' }, MATERIAL)), ['prazo']);
    assert.deepEqual(erros(formulario.montarEdicao({ ...campos, tipo: 'Outro', tipoCustom: '' }, MATERIAL)), ['tipo']);
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

  test('"Sim": quantidade maior que zero e tamanho escolhido são obrigatórios', () => {
    const { formulario } = carregarMateriais();
    const erros = (r) => (r.ok ? [] : r.erros.map((e) => e.campo).sort());
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '' })), ['quantidadeComprada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '0' })), ['quantidadeComprada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, tamanhoEntrada: '' })), ['tamanhoEntrada']);
    assert.deepEqual(erros(formulario.montarCorpo({ ...FORMULARIO, quantidadeComprada: '', tamanhoEntrada: '' })), ['quantidadeComprada', 'tamanhoEntrada']);
    assert.deepEqual(formulario.montarCorpo(FORMULARIO).entrada, { tamanho: '42', quantidade: 120 });
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
    assert.deepEqual(opcoes('materialTipo'), formulario.TIPOS.concat(['Outro']));
    assert.deepEqual(opcoes('materialUnidade'), formulario.UNIDADES);
  });

  test('sem inativar, reativar ou excluir nesta rodada; sem novas rotas', () => {
    const codigo = semComentarios(ler('js/materiais.js'));
    assert.equal(/inativar|reativar|'DELETE'/.test(codigo), false);
    const rotas = [...codigo.matchAll(/requisitar\('([A-Z]+)', (.*?)(?:, \{ corpo: corpo \})?\);/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    assert.deepEqual(rotas, [
      "GET CAMINHO + '/' + encodeURIComponent(id)",
      "GET CAMINHO + '/' + encodeURIComponent(id) + '/estoque'",
      "GET CAMINHO + (q.length ? '?' + q.join('&') : '')",
      "PATCH CAMINHO + '/' + encodeURIComponent(id)",
      'POST CAMINHO',
      "POST CAMINHO + '/' + encodeURIComponent(id) + '/estoque/movimentar'",
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

  test('entrar na edição: o registro real preenche o formulário; título, identificação, Salvar alterações e Cancelar edição; validade do CA 15/10/2026 exata', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL_CA], buscar: (id) => resposta(200, { status: 'ok', material: { ...MATERIAL_CA, id } }) }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    assert.ok(chamadas.some((c) => c.metodo === 'GET' && c.caminho === '/api/materiais/77'));
    const valores = Object.fromEntries(['materialNome', 'materialCategoria', 'materialTipo', 'materialCa', 'materialCaValidade', 'materialFabricante', 'materialCodigo',
      'materialUnidade', 'materialEstoqueMinimo', 'materialValidade', 'materialValidadeTipo', 'materialPrazo', 'materialDesc'].map((id) => [id, pg.el(id).value]));
    assert.deepEqual(valores, {
      materialNome: 'Botina de segurança', materialCategoria: 'EPI', materialTipo: 'Sapatão / Botina', materialCa: '38271', materialCaValidade: '2026-10-15',
      materialFabricante: 'Bracol', materialCodigo: 'EPI-000245', materialUnidade: 'Par', materialEstoqueMinimo: '5', materialValidade: 'sim',
      materialValidadeTipo: 'meses', materialPrazo: '6', materialDesc: 'Biqueira de composite',
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

  test('Salvar alterações: PATCH só com os campos alterados, nenhuma movimentação; sucesso diz que o estoque não mudou, volta ao cadastro e recarrega a grade', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher({ materialNome: 'Botina nova', materialCa: '40000', materialCaValidade: '2028-03-01', materialFabricante: '3M' });
    const antes = chamadas.length;
    await pg.disparar('botaoSalvar');
    const depois = chamadas.slice(antes);
    assert.deepEqual(depois.filter((c) => c.metodo !== 'GET'), [{ metodo: 'PATCH', caminho: '/api/materiais/77', corpo: { nome: 'Botina nova', caNumero: '40000', caValidade: '2028-03-01', fabricante: '3M' } }]);
    assert.ok(depois.some((c) => c.caminho === '/api/materiais/77/estoque'), 'grade recarregada');
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
    assert.deepEqual(chamadas.filter((c) => /movimentar$/.test(c.caminho)).map((c) => [c.corpo.tamanho, c.corpo.quantidade]), [['42', 10]]);
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
// C2 — entrada de estoque em material já cadastrado (25/09/2026):
// "Registrar entrada de estoque" no quadro Grade de tamanhos, pela rota
// existente POST /materiais/:id/estoque/movimentar, somente ENTRADA,
// separada da edição cadastral (nunca PATCH).
// ═══════════════════════════════════════════════════════════════════

const PERMISSOES_SEM_MOVIMENTAR = { recursos: { materials: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: {}, administracao: {} };

async function escolherMaterial(pg, id = 77) {
  pg.el('gradeMaterial').value = String(id);
  await pg.disparar('gradeMaterial', 'change');
}

describe('entrada de estoque posterior — módulo', () => {
  test('montarEntrada: sempre ENTRADA; tamanho escolhido e quantidade > 0 obrigatórios; motivo opcional, aparado; nada de empresaId', () => {
    const { formulario } = carregarMateriais();
    assert.deepEqual(formulario.montarEntrada({ tamanho: '35', quantidade: '5', motivo: '' }), { ok: true, corpo: { tamanho: '35', tipo: 'ENTRADA', quantidade: 5 } });
    assert.deepEqual(formulario.montarEntrada({ tamanho: ' 35 ', quantidade: ' 5 ', motivo: '  Compra NF 123  ' }).corpo, { tamanho: '35', tipo: 'ENTRADA', quantidade: 5, motivo: 'Compra NF 123' });
    const erros = (r) => (r.ok ? [] : r.erros.map((e) => e.campo).sort());
    assert.deepEqual(erros(formulario.montarEntrada({ tamanho: '', quantidade: '5' })), ['tamanho']);
    for (const q of ['', '0', '-1', '1.5', 'abc', '2147483648']) assert.deepEqual(erros(formulario.montarEntrada({ tamanho: '35', quantidade: q })), ['quantidade'], q);
    assert.deepEqual(erros(formulario.montarEntrada({ tamanho: 'x'.repeat(21), quantidade: '5' })), ['tamanho']);
    assert.deepEqual(erros(formulario.montarEntrada({ tamanho: '35', quantidade: '5', motivo: 'x'.repeat(201) })), ['motivo']);
    assert.equal(formulario.montarEntrada({ tamanho: '35', quantidade: '2147483647' }).corpo.quantidade, 2147483647);
    assert.equal(formulario.LIMITES.motivo, 200);
  });

  test('fluxo.registrarEntrada: um único POST na rota existente; recusa 4xx é confirmada; rede e 5xx não confirmadas; nunca repete', async () => {
    const { fluxo } = carregarMateriais();
    servidor(resposta(200, { status: 'ok', saldo: { materialId: 77, tamanho: '35', quantidade: 5 } }));
    const ok = await fluxo.registrarEntrada(77, { tamanho: '35', tipo: 'ENTRADA', quantidade: 5 });
    assert.deepEqual([ok.ok, ok.saldo], [true, { materialId: 77, tamanho: '35', quantidade: 5 }]);
    assert.deepEqual(chamadas, [{ metodo: 'POST', caminho: '/api/materiais/77/estoque/movimentar', corpo: { tamanho: '35', tipo: 'ENTRADA', quantidade: 5 } }]);
    servidor(resposta(403, { status: 'erro', codigo: 'SEM_PERMISSAO' }));
    const negado = await fluxo.registrarEntrada(77, { tamanho: '35', tipo: 'ENTRADA', quantidade: 5 });
    assert.deepEqual([negado.ok, negado.confirmado, chamadas.length], [false, true, 1]);
    servidor(new TypeError('Failed to fetch'));
    const rede = await fluxo.registrarEntrada(77, { tamanho: '35', tipo: 'ENTRADA', quantidade: 5 });
    assert.deepEqual([rede.ok, rede.confirmado, chamadas.length], [false, false, 1]);
  });

  test('fluxo.registrarEntrada força ENTRADA, mesmo que o corpo diga outra coisa', async () => {
    const { fluxo } = carregarMateriais();
    servidor(resposta(200, { status: 'ok', saldo: { materialId: 77, tamanho: '35', quantidade: 5 } }));
    await fluxo.registrarEntrada(77, { tamanho: '35', tipo: 'SAIDA', quantidade: 5 });
    assert.equal(chamadas[0].corpo.tipo, 'ENTRADA');
  });

  test('mensagens: sucesso com tamanho, quantidade e saldo atual; recusa e não confirmado distintos; nada do corpo vaza', () => {
    const { mensagens } = carregarMateriais();
    const ok = mensagens.resultadoEntradaPosterior({ ok: true, saldo: { tamanho: '35', quantidade: 5 } }, { tamanho: '35', quantidade: 5 }, { nome: 'Botina', codigoInterno: 'TESTE-C3-002' });
    assert.equal(ok, 'Entrada de estoque registrada: 5 no tamanho 35 de "Botina" (código TESTE-C3-002). Saldo atual do tamanho 35: 5.');
    assert.match(mensagens.resultadoEntradaPosterior({ ok: false, confirmado: true, resposta: { ok: false, status: 403 } }, {}, {}), /^Entrada de estoque não realizada: .*movimentar estoque/i);
    assert.match(mensagens.resultadoEntradaPosterior({ ok: false, confirmado: true, resposta: { ok: false, status: 409, codigo: 'MATERIAL_INATIVO' } }, {}, {}), /inativo/i);
    const incerta = mensagens.resultadoEntradaPosterior({ ok: false, confirmado: false, resposta: { ok: false, status: 0 } }, {}, {});
    assert.match(incerta, /^Entrada de estoque não confirmada: /);
    assert.match(incerta, /saldo real/i);
    const v = mensagens.resultadoEntradaPosterior({ ok: false, confirmado: true, resposta: { ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ caminho: 'quantidade', valor: 'SEGREDO-9' }] } }, {}, {});
    assert.equal(/SEGREDO-9/.test(v), false);
  });
});

describe('entrada de estoque posterior — inspeção estática', () => {
  const html = ler('pages/materials.html');
  test('bloco no quadro Grade de tamanhos, oculto até a permissão; tamanho sem seleção; só entrada', () => {
    const grade = html.slice(html.indexOf('<h2>Grade de tamanhos</h2>'), html.indexOf('Exemplos de tipos'));
    assert.match(grade, /<div id="blocoEntradaEstoque" style="display:none[^"]*">/);
    assert.match(grade, /Registrar entrada de estoque/);
    assert.match(grade, /<select id="entradaTamanho" class="select"><option value="">Selecione o tamanho<\/option><\/select>/);
    assert.match(grade, /<input id="entradaQuantidade" class="input" type="number" min="1"/);
    assert.match(grade, /<input id="entradaMotivo" class="input" type="text" maxlength="200"/);
    assert.match(grade, /<button id="botaoRegistrarEntrada" class="filled-btn" type="button" disabled>/);
    assert.equal(/SAIDA|Saída/i.test(grade.replace(/Registrar entrada de estoque/g, '')), false, 'nenhuma saída nesta funcionalidade');
  });
});

describe('entrada de estoque posterior — página', () => {
  test('sem MOVIMENTAR_ESTOQUE: bloco oculto e nenhuma movimentação possível', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_SEM_MOVIMENTAR });
    await pg.esperar();
    await escolherMaterial(pg);
    assert.equal(pg.el('blocoEntradaEstoque').style.display, 'none');
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5' });
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(chamadas.some((c) => /movimentar$/.test(c.caminho)), false);
  });

  test('com MOVIMENTAR_ESTOQUE: bloco visível; botão só com material escolhido; tamanhos sugeridos do tipo mais a grade, começando sem seleção', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(pg.el('blocoEntradaEstoque').style.display, '');
    assert.equal(pg.el('botaoRegistrarEntrada').disabled, true);
    await escolherMaterial(pg);
    assert.equal(pg.el('botaoRegistrarEntrada').disabled, false);
    assert.match(pg.el('entradaTamanho').innerHTML, /^<option value="">Selecione o tamanho<\/option><option value="34">34<\/option><option value="35">35<\/option>/);
    assert.equal(pg.el('entradaTamanho').value, '');
  });

  test('tamanho já registrado fora da grade padrão também aparece na lista', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], saldos: [{ tamanho: '45 largo', quantidade: 2 }] }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    assert.match(pg.el('entradaTamanho').innerHTML, /<option value="45 largo">45 largo<\/option>/);
  });

  test('entrada de 5 no tamanho 35: um POST ENTRADA na rota existente, nenhum PATCH; grade recarregada; mensagem com o saldo; campos limpos', async () => {
    const estado = estadoPadrao({ materiais: [MATERIAL] });
    servidorRotas(estado);
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    const antes = chamadas.length;
    estado.saldos = [{ tamanho: '35', quantidade: 5 }];
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5', entradaMotivo: '' });
    await pg.disparar('botaoRegistrarEntrada');
    const depois = chamadas.slice(antes);
    assert.deepEqual(depois.filter((c) => c.metodo !== 'GET'), [{ metodo: 'POST', caminho: '/api/materiais/77/estoque/movimentar', corpo: { tamanho: '35', tipo: 'ENTRADA', quantidade: 5 } }]);
    assert.ok(depois.some((c) => c.metodo === 'GET' && c.caminho === '/api/materiais/77/estoque'), 'grade recarregada');
    assert.match(pg.el('sizeChipsGrid').innerHTML, /title="5 em estoque">35</);
    assert.match(pg.el('aviso').innerHTML, /Entrada de estoque registrada: 5 no tamanho 35/);
    assert.match(pg.el('aviso').innerHTML, /Saldo atual do tamanho 35: 5/);
    assert.deepEqual([pg.el('entradaTamanho').value, pg.el('entradaQuantidade').value, pg.el('entradaMotivo').value], ['', '', '']);
    assert.equal(pg.el('gradeMaterial').value, '77', 'mesmo material selecionado');
  });

  test('motivo preenchido vai no corpo, aparado', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5', entradaMotivo: '  Compra NF 123 ' });
    await pg.disparar('botaoRegistrarEntrada');
    assert.deepEqual(chamadas.filter((c) => c.metodo === 'POST').map((c) => c.corpo), [{ tamanho: '35', tipo: 'ENTRADA', quantidade: 5, motivo: 'Compra NF 123' }]);
  });

  test('sem tamanho ou com quantidade inválida: nada é enviado e o campo é marcado', async () => {
    for (const [campos, id] of [[{ entradaTamanho: '', entradaQuantidade: '5' }, 'entradaTamanho'], [{ entradaTamanho: '35', entradaQuantidade: '0' }, 'entradaQuantidade'], [{ entradaTamanho: '35', entradaQuantidade: '' }, 'entradaQuantidade']]) {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
      const pg = montarPagina();
      await pg.esperar();
      await escolherMaterial(pg);
      pg.preencher(campos);
      await pg.disparar('botaoRegistrarEntrada');
      assert.equal(chamadas.some((c) => c.metodo === 'POST'), false, id);
      assert.equal(pg.el(id).atributos['aria-invalid'], 'true', id);
    }
  });

  test('recusa 403 e 409 (inativo): mensagem de erro, campos preservados; rede: "não confirmada", um único POST, grade recarregada para conferência', async () => {
    for (const [status, codigo, texto] of [[403, 'SEM_PERMISSAO', /movimentar estoque/i], [409, 'MATERIAL_INATIVO', /inativo/i]]) {
      servidorRotas(estadoPadrao({ materiais: [MATERIAL], movimentar: () => resposta(status, { status: 'erro', codigo }) }));
      const pg = montarPagina();
      await pg.esperar();
      await escolherMaterial(pg);
      pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5' });
      await pg.disparar('botaoRegistrarEntrada');
      assert.match(pg.el('aviso').innerHTML, texto, String(status));
      assert.equal(pg.el('entradaQuantidade').value, '5', 'campos preservados');
    }
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], movimentar: () => new TypeError('Failed to fetch') }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5' });
    const antes = chamadas.length;
    await pg.disparar('botaoRegistrarEntrada');
    const depois = chamadas.slice(antes);
    assert.equal(depois.filter((c) => c.metodo === 'POST').length, 1);
    assert.match(pg.el('aviso').innerHTML, /Entrada de estoque não confirmada/);
    assert.match(pg.el('aviso').innerHTML, /C07000/);
    assert.ok(depois.some((c) => c.caminho === '/api/materiais/77/estoque'), 'grade recarregada para conferência');
  });

  test('401 na entrada devolve ao Portal', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], movimentar: () => resposta(401, { status: 'erro', codigo: 'SESSAO_INVALIDA' }) }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5' });
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('trocar de material limpa os campos da entrada e refaz a lista de tamanhos', async () => {
    const B = { ...MATERIAL, id: 88, nome: 'Luva B', tipo: 'Luva' };
    servidorRotas(estadoPadrao({ materiais: [MATERIAL, B] }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5', entradaMotivo: 'x' });
    await escolherMaterial(pg, 88);
    assert.deepEqual([pg.el('entradaTamanho').value, pg.el('entradaQuantidade').value, pg.el('entradaMotivo').value], ['', '', '']);
  });

  test('sessão encerrada durante a entrada: resposta posterior não é aplicada; bloco oculto', async () => {
    const lenta = pendente();
    servidorRotas(estadoPadrao({ materiais: [MATERIAL], movimentar: () => lenta.promessa }));
    const pg = montarPagina();
    await pg.esperar();
    await escolherMaterial(pg);
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5' });
    const envio = pg.disparar('botaoRegistrarEntrada');
    await pg.esperar();
    pg.sandbox.opcoesMontar.aoEncerrar();
    lenta.resolver(resposta(200, { status: 'ok', saldo: { materialId: 77, tamanho: '35', quantidade: 5 } }));
    await envio;
    await pg.esperar();
    assert.equal(/Entrada de estoque registrada/.test(pg.el('aviso').innerHTML), false);
    assert.equal(pg.el('blocoEntradaEstoque').style.display, 'none');
  });

  test('a entrada não interfere na edição cadastral: em modo edição, registrar entrada não envia PATCH nem sai da edição', async () => {
    servidorRotas(estadoPadrao({ materiais: [MATERIAL] }));
    const pg = montarPagina({ permissoes: PERMISSOES_EDITAR });
    await pg.esperar();
    await abrirEdicao(pg);
    pg.preencher({ entradaTamanho: '35', entradaQuantidade: '5' });
    await pg.disparar('botaoRegistrarEntrada');
    assert.equal(chamadas.some((c) => c.metodo === 'PATCH'), false);
    assert.equal(chamadas.filter((c) => /movimentar$/.test(c.caminho)).length, 1);
    assert.equal(pg.el('tituloFormulario').textContent, 'Editar material / EPI');
  });
});
