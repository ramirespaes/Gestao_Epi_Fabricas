'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const { estiloComputado, token } = require('./helpers/estilo-computado');

const { MOTIVOS: MOTIVOS_DO_BACKEND, TAMANHO_MAXIMO, JUSTIFICATIVA_MAXIMA } = require('../../backend/src/repositories/solicitacao-epi-item.repository');
const { OBSERVACAO_MAXIMA, JUSTIFICATIVA_MAXIMA: JUSTIFICATIVA_CANCELAMENTO } = require('../../backend/src/repositories/solicitacao-epi.repository');
const { LIMITE_ITENS } = require('../../backend/src/services/solicitacao-epi.service');

/**
 * 12G-2 — Pedido de EPI funcional (pages/request.html + js/pedido-epi.js),
 * aberto como no navegador, com um "servidor" que responde nos formatos reais
 * da 12F e da 12G-0: busca do trabalhador, EPIs previstos no GHE dele, itens
 * com tamanho, quantidade, motivo e justificativa, envio idempotente, "meus
 * pedidos", detalhe e cancelamento. Permissões só as efetivas. O contrato com o
 * servidor real está em backend/test/integracao/frontend-12g2-contrato.integration.js.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const TODAS = { visualizar: true, criar: true, editar: true, excluir: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function permissoes({ perfil = 'USUARIO', request = TODAS } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil, recursos: { request }, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}

const TRABALHADORES = [
  { id: 11, nome: 'Ana Sintética', matricula: 'M-011', setor: 'Fundição', funcao: 'Operadora', cpf: '52998224725' },
  { id: 12, nome: 'Bruno Sintético', matricula: 'M-012', setor: null, funcao: null },
];
const MATERIAIS = {
  11: [
    { id: 30, nome: 'Botina de segurança', unidade: 'par', exigeTamanho: true, previstoNoGhe: true, tamanhosSugeridos: ['39', '40', '41'], saldo: 77 },
    { id: 31, nome: 'Capacete', unidade: 'unidade', exigeTamanho: false, previstoNoGhe: true, tamanhosSugeridos: [] },
    { id: 32, nome: 'Luva nova', unidade: 'par', exigeTamanho: true, previstoNoGhe: true, tamanhosSugeridos: [] },
  ],
  12: [{ id: 40, nome: 'Protetor auricular', unidade: 'unidade', exigeTamanho: false, previstoNoGhe: true, tamanhosSugeridos: [] }],
};
const linha = (extra = {}) => ({
  id: 101, numero: 7, status: 'PENDENTE', situacaoOperacional: 'AGUARDANDO_ESTOQUE', solicitanteUsuarioId: 7,
  funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', ativo: true }, quantidadeItens: 2,
  quantidades: { solicitada: 3, aprovada: 0, entregue: 0, restante: 0 }, criadaEm: '2026-10-03T13:05:00.000Z', decididaEm: null, canceladaEm: null, entregueEm: null, encerradaEm: null,
  ...extra,
});
function detalheDe(status = 'PENDENTE', extra = {}) {
  const decidida = ['APROVADA', 'APROVADA_PARCIAL', 'REPROVADA'].includes(status);
  return {
    status: 'ok',
    solicitacao: {
      id: 101, numero: 7, status, origemSolicitacao: 'INTERNA', solicitanteUsuarioId: 7, funcionarioId: 11, gheId: 2, quantidadeItens: 2,
      observacao: 'Turno da noite', criadaEm: '2026-10-03T13:05:00.000Z',
      decisao: decidida ? { decididaPor: 9, decididaEm: '2026-10-03T15:00:00.000Z', decisor: { id: 9, nome: 'Diego SST' } } : null,
      cancelamento: status === 'CANCELADA' ? { canceladaPor: 7, canceladaEm: '2026-10-03T14:00:00.000Z', justificativa: 'Pedido em duplicidade' } : null,
      entregueEm: null, encerramento: null, situacaoOperacional: 'AGUARDANDO_ESTOQUE',
      quantidades: { solicitada: 3, aprovada: 0, entregue: 0, restante: 0 },
      funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', setor: 'Fundição', funcao: 'Operadora', ativo: true, cpf: '52998224725' },
      solicitante: { id: 7, nome: 'Pessoa Solicitante', email: 'solicitante@example.invalid' },
      ...extra,
    },
    itens: [
      {
        id: 1, materialId: 30, tamanho: '40', quantidade: 2, motivo: 'DESGASTE_DANO', justificativa: null, previstoNoGhe: true,
        decisao: decidida ? (status === 'REPROVADA' ? 'REPROVADO' : 'APROVADO') : null, quantidadeAprovada: status === 'APROVADA' ? 2 : null,
        justificativaDecisao: status === 'REPROVADA' ? 'Troca recente' : null, quantidadeEntregue: 0, quantidadePendente: null, situacao: 'AGUARDANDO_ESTOQUE',
        material: { nome: 'Botina de segurança', unidade: 'par' }, cobertura: { coberta: 5 }, posicao: { saldoLivre: 88 },
      },
      {
        id: 2, materialId: 31, tamanho: null, quantidade: 1, motivo: 'OUTRO', justificativa: 'Capacete trincado', previstoNoGhe: true,
        decisao: decidida ? (status === 'REPROVADA' ? 'REPROVADO' : 'APROVADO') : null, quantidadeAprovada: status === 'APROVADA' ? 1 : null,
        justificativaDecisao: status === 'REPROVADA' ? 'Troca recente' : null, quantidadeEntregue: 0, quantidadePendente: null, situacao: null,
        material: { nome: 'Capacete', unidade: 'unidade' },
      },
    ],
  };
}

/** "Servidor" com estado: o teste troca respostas no meio do caminho. */
function servidor({ p = permissoes(), minhas = [linha()], totalMinhas = null, detalhe = detalheDe(), criar = null, cancelar = null, materiais = MATERIAIS } = {}) {
  const s = { p, minhas, totalMinhas, detalhe, criar, cancelar, materiais, pendente: {} };
  const corpo = (status, c) => ({ status, corpo: c });
  const segurar = (nome, resposta) => (s.pendente[nome] ? new Promise((r) => { s.pendente[nome] = () => { s.pendente[nome] = false; r(resposta()); }; }) : resposta());
  const rotas = {
    'GET /auth/me': () => corpo(200, { status: 'ok', usuario: { id: 7, nome: 'Pessoa Solicitante', email: 'solicitante@example.invalid', perfil: s.p.perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }),
    'GET /auth/global/me': () => corpo(200, { status: 'ok', empresas: [{ id: 3 }] }),
    'GET /auth/permissoes': () => corpo(200, s.p),
    'GET /solicitacoes-epi/contexto/funcionarios': (c) => segurar('funcionarios', () => {
      if (s.erroFuncionarios) return corpo(s.erroFuncionarios, { status: 'error', codigo: 'X', message: 'falha interna em SQL' });
      const busca = (new URL(c.url).searchParams.get('busca') || '').toLowerCase();
      const lista = (s.trabalhadores || TRABALHADORES).filter((t) => !busca || t.nome.toLowerCase().includes(busca) || t.matricula.toLowerCase().includes(busca));
      return corpo(200, { status: 'ok', funcionarios: lista, total: lista.length, pagina: 1, limite: 20 });
    }),
    'GET /solicitacoes-epi/minhas': () => segurar('minhas', () => {
      if (s.erroMinhas) return corpo(s.erroMinhas, { status: 'error', codigo: 'X', message: 'x' });
      return corpo(200, { status: 'ok', solicitacoes: s.minhas, total: s.totalMinhas ?? s.minhas.length, pagina: 1, limite: 10 });
    }),
    'GET /solicitacoes-epi/101': () => (typeof s.detalhe === 'function' ? s.detalhe() : (s.detalhe.status === 'ok' ? corpo(200, s.detalhe) : s.detalhe)),
    'POST /solicitacoes-epi': (c) => segurar('criar', () => (s.criar ? s.criar(c) : corpo(201, { status: 'ok', repetida: false, solicitacao: { id: 102, numero: 8, status: 'PENDENTE' }, itens: [] }))),
    'POST /solicitacoes-epi/101/cancelamento': (c) => segurar('cancelar', () => (s.cancelar ? s.cancelar(c) : corpo(200, { status: 'ok', solicitacao: { id: 101, numero: 7, status: 'CANCELADA' }, itens: [] }))),
  };
  for (const [id, lista] of Object.entries(MATERIAIS)) {
    rotas[`GET /solicitacoes-epi/contexto/${id}/materiais`] = (c) => segurar('materiais', () => {
      if (s.erroMateriais) return corpo(s.erroMateriais, { status: 'error', codigo: 'X', message: 'falha interna' });
      const u = new URL(c.url).searchParams;
      const todos = s.materiais[id] || [];
      const pagina = Number(u.get('pagina'));
      const limite = Number(u.get('limite'));
      return corpo(200, { status: 'ok', funcionarioId: Number(id), materiais: todos.slice((pagina - 1) * limite, pagina * limite), total: todos.length, pagina, limite });
    });
    void lista;
  }
  return { s, rotas };
}

async function abrir(opcoes = {}) {
  assert.ok(fs.existsSync(path.join(RAIZ, 'js/pedido-epi.js')), 'comportamento ausente: js/pedido-epi.js (a tela funcional do Pedido de EPI) não existe');
  const { s, rotas } = servidor(opcoes);
  const pg = abrirPagina('pages/request.html', { rotas });
  await pg.esperar();
  return { pg, s };
}
const chamadas = (pg, chave) => pg.chamadas.filter((c) => c.chave === chave);
const itens = (pg) => pg.consulta('#listaItens [data-item]');
const campo = (item, nome) => item.querySelector(`[data-campo="${nome}"]`);
const erro = (item, nome) => { const e = item.querySelector(`[data-erro="${nome}"]`); return e ? e.textContent : ''; };
async function escolher(el, valor) { el.value = String(valor); await el.disparar('change'); await el.disparar('input'); }
async function selecionarTrabalhador(pg, nome = 'Ana') {
  await pg.digitar('buscaTrabalhador', nome);
  await pg.enviar('formBuscaTrabalhador');
  const opcao = pg.consulta('#resultadoTrabalhadores [data-funcionario-id]')[0];
  await opcao.disparar('click');
  await pg.esperar();
}
async function preencherItem(pg, i, { material, tamanho, quantidade = '1', motivo = 'ADMISSAO', justificativa }) {
  const item = itens(pg)[i];
  await escolher(campo(item, 'materialId'), material);
  await pg.esperar();
  const atual = itens(pg)[i];
  if (tamanho !== undefined) await escolher(campo(atual, 'tamanho'), tamanho);
  await escolher(campo(atual, 'quantidade'), quantidade);
  await escolher(campo(atual, 'motivo'), motivo);
  await pg.esperar();
  if (justificativa !== undefined) await escolher(campo(itens(pg)[i], 'justificativa'), justificativa);
}
const enviar = async (pg) => { await pg.clicar('botaoEnviarPedido'); await pg.esperar(); };
const texto = (pg, id) => pg.el(id).textContent;

// ─────────────────────────────────────────────────────────────────────
describe('contrato: motivos e limites são os do backend, nunca inventados', () => {
  test('motivos com rótulo, limites de itens, tamanho, justificativa e observação', () => {
    const S = require('../js/solicitacoes-epi'); // eslint-disable-line global-require
    assert.deepEqual(S.MOTIVOS && [...S.MOTIVOS], [...MOTIVOS_DO_BACKEND]);
    for (const m of MOTIVOS_DO_BACKEND) assert.equal(typeof S.ROTULOS_MOTIVO[m], 'string', m);
    assert.deepEqual(S.LIMITES_PEDIDO, { itens: LIMITE_ITENS, tamanho: TAMANHO_MAXIMO, justificativa: JUSTIFICATIVA_MAXIMA, observacao: OBSERVACAO_MAXIMA, justificativaCancelamento: JUSTIFICATIVA_CANCELAMENTO, quantidade: 2147483647 });
    const F = require('../js/epi-ficha'); // eslint-disable-line global-require
    for (const m of F.MOTIVOS) assert.equal(S.ROTULOS_MOTIVO[m.codigo], m.rotulo, 'o mesmo rótulo da Ficha de EPI');
  });

  test('12G-8: tamanho fora da grade do EPI tem texto próprio no campo do item (o backend recusa)', () => {
    const S = require('../js/solicitacoes-epi'); // eslint-disable-line global-require
    const r = { ok: false, status: 400, codigo: 'VALIDACAO', detalhes: [{ campo: 'body.itens[0].tamanho', codigo: 'TAMANHO_FORA_DA_GRADE', mensagem: 'SEGREDO' }] };
    const [campo] = S.mensagens.deCampos(r);
    assert.deepEqual([campo.campo, campo.codigo], ['body.itens[0].tamanho', 'TAMANHO_FORA_DA_GRADE']);
    assert.match(campo.mensagem, /grade de tamanhos deste EPI/);
    assert.equal(/SEGREDO/.test(campo.mensagem), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('A. trabalhador', () => {
  test('busca real na empresa da sessão: nome, matrícula, setor e função; nunca CPF; nada de empresa ou usuário na consulta', async () => {
    const { pg } = await abrir();
    await pg.digitar('buscaTrabalhador', '  Ana ');
    await pg.enviar('formBuscaTrabalhador');
    const busca = chamadas(pg, 'GET /solicitacoes-epi/contexto/funcionarios')[0];
    assert.equal(new URL(busca.url).search, '?busca=Ana&pagina=1&limite=20');
    const opcoes = pg.consulta('#resultadoTrabalhadores [data-funcionario-id]');
    assert.equal(opcoes.length, 1);
    assert.match(opcoes[0].textContent, /Ana Sintética/);
    assert.match(opcoes[0].textContent, /M-011/);
    assert.match(opcoes[0].textContent, /Fundição/);
    assert.match(opcoes[0].textContent, /Operadora/);
    assert.equal(/52998224725|CPF/i.test(pg.textoDoDom()), false);
  });

  test('carregando, vazio e erro na busca', async () => {
    const { pg, s } = await abrir();
    s.pendente.funcionarios = true;
    await pg.digitar('buscaTrabalhador', 'Ana');
    pg.enviarSemEsperar('formBuscaTrabalhador');
    await pg.esperar();
    assert.equal(pg.consulta('#resultadoTrabalhadores [data-estado="carregando"]').length, 1);
    s.pendente.funcionarios();
    await pg.esperar();
    await pg.digitar('buscaTrabalhador', 'Ninguém');
    await pg.enviar('formBuscaTrabalhador');
    assert.equal(pg.consulta('#resultadoTrabalhadores [data-estado="vazio"]').length, 1);
    s.erroFuncionarios = 500;
    await pg.enviar('formBuscaTrabalhador');
    assert.equal(pg.consulta('#resultadoTrabalhadores [data-estado="erro"]').length, 1);
    assert.equal(/SQL/.test(texto(pg, 'resultadoTrabalhadores')), false, 'nada técnico do servidor');
  });

  test('a resposta atrasada de uma busca anterior não substitui a da busca atual', async () => {
    const { pg, s } = await abrir();
    s.pendente.funcionarios = true;
    await pg.digitar('buscaTrabalhador', 'Ana');
    pg.enviarSemEsperar('formBuscaTrabalhador');
    await pg.esperar();
    const primeira = s.pendente.funcionarios;
    s.pendente.funcionarios = false;
    await pg.digitar('buscaTrabalhador', 'Bruno');
    await pg.enviar('formBuscaTrabalhador');
    primeira();
    await pg.esperar();
    assert.deepEqual(pg.consulta('#resultadoTrabalhadores [data-funcionario-id]').map((o) => o.getAttribute('data-funcionario-id')), ['12']);
  });

  test('ao escolher: resumo do trabalhador, busca recolhida e EPIs previstos no GHE dele carregados', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    assert.equal(pg.visivel('trabalhadorSelecionado'), true);
    assert.equal(pg.visivel('formBuscaTrabalhador'), false);
    assert.match(texto(pg, 'trabalhadorSelecionado'), /Ana Sintética[\s\S]*M-011[\s\S]*Fundição[\s\S]*Operadora/);
    const materiais = chamadas(pg, 'GET /solicitacoes-epi/contexto/11/materiais');
    assert.equal(new URL(materiais[0].url).search, '?previstoNoGhe=true&pagina=1&limite=100');
    assert.equal(pg.visivel('blocoItens'), true);
  });

  test('trocar de trabalhador limpa os itens e os EPIs do anterior', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 30, tamanho: '40' });
    await pg.clicar('botaoTrocarTrabalhador');
    assert.equal(pg.visivel('formBuscaTrabalhador'), true);
    assert.equal(pg.visivel('blocoItens'), false);
    await selecionarTrabalhador(pg, 'Bruno');
    const opcoes = campo(itens(pg)[0], 'materialId').querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.deepEqual(opcoes, ['', '40'], 'só os EPIs do novo trabalhador; nada do anterior');
    assert.equal(campo(itens(pg)[0], 'materialId').value, '');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('B. EPIs do trabalhador', () => {
  test('só os EPIs devolvidos pelo servidor para ele, com unidade; sem catálogo fictício e sem números de estoque', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    const select = campo(itens(pg)[0], 'materialId');
    assert.deepEqual(select.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent]), [
      ['', 'Escolha o EPI'], ['30', 'Botina de segurança (par)'], ['31', 'Capacete (unidade)'], ['32', 'Luva nova (par)'],
    ]);
    assert.equal(/\b77\b|saldo|estoque|lote/i.test(texto(pg, 'cardNovaSolicitacao')), false, 'nada de estoque no formulário de quem pede');
  });

  test('tamanho só para o EPI que exige: sugestões do servidor (sem esconder nada); o que não exige não pede tamanho', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await escolher(campo(itens(pg)[0], 'materialId'), 30);
    let item = itens(pg)[0];
    assert.equal(pg.visivelNo(campo(item, 'tamanho')), true);
    const lista = pg.documento.getElementById(campo(item, 'tamanho').getAttribute('list'));
    assert.deepEqual(lista.querySelectorAll('option').map((o) => o.getAttribute('value')), ['39', '40', '41']);
    await escolher(campo(item, 'materialId'), 31);
    item = itens(pg)[0];
    assert.equal(campo(item, 'tamanho') === null || !pg.visivelNo(campo(item, 'tamanho')), true);
    assert.match(item.textContent, /não usa tamanho/i);
    await escolher(campo(item, 'materialId'), 32);
    item = itens(pg)[0];
    assert.equal(pg.visivelNo(campo(item, 'tamanho')), true, 'sem sugestão, o tamanho continua livre para digitar');
  });

  test('sem EPI previsto no GHE: estado vazio claro e nada para enviar', async () => {
    const { pg } = await abrir({ materiais: { ...MATERIAIS, 11: [] } });
    await selecionarTrabalhador(pg);
    assert.equal(pg.consulta('#estadoMateriais [data-estado="vazio"]').length, 1);
    assert.match(texto(pg, 'estadoMateriais'), /Nenhum EPI está previsto no GHE/);
    assert.equal(pg.visivel('materiaisPendentes'), false);
    assert.equal(pg.el('botaoEnviarPedido').disabled, true);
    assert.equal(pg.el('botaoAdicionarItem').disabled, true);
  });

  const LEGADOS = ['BOTINA DE SEGURANÇA — TESTE C2', 'Botina teste'].map((nome, i) => ({
    id: 50 + i, nome, unidade: 'par', exigeTamanho: null, previstoNoGhe: true, tamanhosSugeridos: [],
  }));

  test('validação visual: GHE só com EPIs ainda sem a classificação de tamanho — nada de "nenhum EPI previsto"; a tela lista os do GHE e explica por que não podem ser pedidos', async () => {
    const { pg } = await abrir({ materiais: { ...MATERIAIS, 11: LEGADOS } });
    await selecionarTrabalhador(pg);
    const estado = texto(pg, 'estadoMateriais');
    assert.equal(/Nenhum EPI está previsto/.test(estado), false, estado);
    assert.match(estado, /2 EPIs/);
    assert.equal(pg.visivel('materiaisPendentes'), true);
    assert.match(texto(pg, 'materiaisPendentes'), /BOTINA DE SEGURANÇA — TESTE C2[\s\S]*Botina teste/);
    assert.match(texto(pg, 'materiaisPendentes'), /cadastro de Materiais[\s\S]*tamanho/);
    assert.equal(pg.visivel('listaItens'), false, 'nada escolhível');
    assert.equal(pg.el('botaoEnviarPedido').disabled, true);
    assert.equal(pg.el('botaoAdicionarItem').disabled, true);
  });

  test('GHE com EPIs classificados e não classificados: só os classificados são escolhíveis; os outros ficam no aviso; trocar de trabalhador limpa o aviso', async () => {
    const { pg } = await abrir({ materiais: { ...MATERIAIS, 11: [...MATERIAIS[11], { ...LEGADOS[1], id: 60, nome: 'Botina teste ramires' }] } });
    await selecionarTrabalhador(pg);
    assert.deepEqual(campo(itens(pg)[0], 'materialId').querySelectorAll('option').map((o) => o.getAttribute('value')), ['', '30', '31', '32']);
    assert.equal(pg.visivel('materiaisPendentes'), true);
    assert.match(texto(pg, 'materiaisPendentes'), /Botina teste ramires/);
    await pg.clicar('botaoTrocarTrabalhador');
    assert.equal(pg.visivel('materiaisPendentes'), false);
    assert.equal(texto(pg, 'materiaisPendentes'), '', 'nada do trabalhador anterior fica no DOM, nem oculto');
    await selecionarTrabalhador(pg, 'Bruno');
    assert.equal(pg.visivel('materiaisPendentes'), false);
    assert.equal(texto(pg, 'materiaisPendentes'), '');
  });

  test('a lista de EPIs é relida e falha: o aviso dos não classificados não fica de uma lista que não vale mais', async () => {
    const { pg, s } = await abrir({
      materiais: { ...MATERIAIS, 11: [...MATERIAIS[11], { ...LEGADOS[1], id: 60, nome: 'Botina teste ramires' }] },
      criar: () => ({ status: 409, corpo: { status: 'error', codigo: 'MATERIAL_INATIVO', message: 'x' } }),
    });
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    assert.match(texto(pg, 'materiaisPendentes'), /Botina teste ramires/);
    s.pendente.materiais = true;
    pg.el('botaoEnviarPedido').disparar('click');
    await pg.esperar();
    assert.equal(texto(pg, 'materiaisPendentes'), '', 'enquanto relê, o aviso antigo sai');
    s.erroMateriais = 500;
    s.pendente.materiais();
    await pg.esperar();
    assert.equal(pg.consulta('#estadoMateriais [data-estado="erro"]').length, 1);
    assert.equal([pg.visivel('materiaisPendentes'), texto(pg, 'materiaisPendentes')].join('|'), 'false|');
  });

  test('rascunho: EPI sem a classificação de tamanho nunca vira corpo de envio', () => {
    require('../js/solicitacoes-epi'); // eslint-disable-line global-require
    const P = require('../js/pedido-epi'); // eslint-disable-line global-require
    const v = P.rascunho.validar({
      funcionario: { id: 11 }, materiais: { 50: LEGADOS[0] }, itens: [{ ...P.rascunho.novoItem(), materialId: 50, motivo: 'ADMISSAO' }], observacao: '',
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.erros.map((e) => [e.campo, e.mensagem]), [['materialId', 'Este EPI ainda não pode ser pedido: falta definir no cadastro de Materiais se ele usa tamanho.']]);
  });

  test('mais de 100 EPIs previstos: todas as páginas são lidas', async () => {
    const muitos = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, nome: `EPI ${i}`, unidade: 'unidade', exigeTamanho: false, previstoNoGhe: true, tamanhosSugeridos: [] }));
    const { pg } = await abrir({ materiais: { ...MATERIAIS, 11: muitos } });
    await selecionarTrabalhador(pg);
    assert.deepEqual(chamadas(pg, 'GET /solicitacoes-epi/contexto/11/materiais').map((c) => new URL(c.url).searchParams.get('pagina')), ['1', '2']);
    assert.equal(campo(itens(pg)[0], 'materialId').querySelectorAll('option').length, 121);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('C. formulário', () => {
  test('adicionar e remover itens; um item não se remove; o limite do servidor trava o "+ Adicionar"', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    assert.equal(itens(pg).length, 1);
    assert.equal(itens(pg)[0].querySelector('[data-acao="remover-item"]').disabled, true);
    assert.equal(pg.el('botaoAdicionarItem').disabled, false);
    await pg.clicar('botaoAdicionarItem');
    assert.equal(itens(pg).length, 2);
    assert.equal(itens(pg)[0].querySelector('[data-acao="remover-item"]').disabled, false);
    await itens(pg)[1].querySelector('[data-acao="remover-item"]').disparar('click');
    await pg.esperar();
    assert.equal(itens(pg).length, 1);
    for (let i = 1; i < LIMITE_ITENS; i += 1) await pg.clicar('botaoAdicionarItem');
    assert.equal(itens(pg).length, LIMITE_ITENS);
    assert.equal(pg.el('botaoAdicionarItem').disabled, true);
  });

  test('validação amigável antes do envio: EPI, tamanho, quantidade e motivo; nada vai ao servidor', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await enviar(pg);
    assert.match(erro(itens(pg)[0], 'materialId'), /Escolha o EPI/);
    await escolher(campo(itens(pg)[0], 'materialId'), 30);
    for (const q of ['0', '1.5', 'abc', '']) {
      await escolher(campo(itens(pg)[0], 'quantidade'), q);
      await enviar(pg);
      assert.match(erro(itens(pg)[0], 'quantidade'), /quantidade inteira/i, q);
    }
    assert.match(erro(itens(pg)[0], 'tamanho'), /Informe o tamanho/);
    assert.match(erro(itens(pg)[0], 'motivo'), /Escolha o motivo/);
    assert.equal(erro(itens(pg)[0], 'materialId'), '', 'o erro resolvido some');
    assert.equal(campo(itens(pg)[0], 'tamanho').getAttribute('aria-invalid'), 'true');
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi').length, 0);
  });

  test('"Outro" pede justificativa (obrigatória); outro motivo esconde e não envia a justificativa', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31, motivo: 'OUTRO' });
    assert.equal(pg.visivelNo(campo(itens(pg)[0], 'justificativa')), true);
    await enviar(pg);
    assert.match(erro(itens(pg)[0], 'justificativa'), /Explique/);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi').length, 0);
    await escolher(campo(itens(pg)[0], 'justificativa'), 'Capacete trincado');
    await escolher(campo(itens(pg)[0], 'motivo'), 'ADMISSAO');
    await pg.esperar();
    assert.equal(campo(itens(pg)[0], 'justificativa') === null || !pg.visivelNo(campo(itens(pg)[0], 'justificativa')), true);
    await enviar(pg);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi')[0].corpo.itens[0].justificativa, null);
  });

  test('mesmo EPI e tamanho repetido é barrado com aviso; o mesmo EPI em outro tamanho pode', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 30, tamanho: '40' });
    await pg.clicar('botaoAdicionarItem');
    await preencherItem(pg, 1, { material: 30, tamanho: ' 40 ' });
    await enviar(pg);
    assert.match(erro(itens(pg)[1], 'materialId'), /já está no item 1/);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi').length, 0);
    await escolher(campo(itens(pg)[1], 'tamanho'), '41');
    await enviar(pg);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi').length, 1);
  });

  test('observação opcional (vazia vai como null) com o limite do servidor', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    assert.equal(pg.el('observacaoPedido').getAttribute('maxlength'), String(OBSERVACAO_MAXIMA));
    await preencherItem(pg, 0, { material: 31 });
    await pg.digitar('observacaoPedido', '   ');
    await enviar(pg);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi')[0].corpo.observacao, null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('D. envio', () => {
  test('corpo exato do contrato, com a chave de idempotência; nunca empresa, usuário ou ator', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 30, tamanho: ' 40 ', quantidade: '2', motivo: 'DESGASTE_DANO' });
    await pg.clicar('botaoAdicionarItem');
    await preencherItem(pg, 1, { material: 31, motivo: 'OUTRO', justificativa: '  Capacete trincado ' });
    await pg.digitar('observacaoPedido', 'Turno da noite');
    await enviar(pg);
    const [post] = chamadas(pg, 'POST /solicitacoes-epi');
    const { chaveIdempotencia, ...resto } = post.corpo;
    assert.match(chaveIdempotencia, UUID);
    assert.deepEqual(resto, {
      funcionarioId: 11,
      itens: [
        { materialId: 30, tamanho: '40', quantidade: 2, motivo: 'DESGASTE_DANO', justificativa: null },
        { materialId: 31, tamanho: null, quantidade: 1, motivo: 'OUTRO', justificativa: 'Capacete trincado' },
      ],
      observacao: 'Turno da noite',
    });
    assert.equal(/empresa|usuario|ator|perfil/i.test(JSON.stringify(Object.keys(post.corpo))), false);
  });

  test('clique duplo: um só POST; o botão fica ocupado enquanto o servidor responde', async () => {
    const { pg, s } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    s.pendente.criar = true;
    pg.el('botaoEnviarPedido').disparar('click');
    pg.el('botaoEnviarPedido').disparar('click');
    await pg.esperar();
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi').length, 1);
    assert.equal(pg.el('botaoEnviarPedido').disabled, true);
    assert.equal(pg.el('botaoEnviarPedido').getAttribute('aria-busy'), 'true');
    s.pendente.criar();
    await pg.esperar();
    assert.equal(pg.el('botaoEnviarPedido').disabled, false);
  });

  test('com o envio em andamento, nem o botão reabilitado por outra renderização gera um segundo POST', async () => {
    const { pg, s } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    s.pendente.criar = true;
    pg.el('botaoEnviarPedido').disparar('click');
    await pg.esperar();
    pg.el('botaoEnviarPedido').disabled = false;
    pg.el('botaoEnviarPedido').disparar('click');
    await pg.esperar();
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi').length, 1);
    s.pendente.criar();
    await pg.esperar();
  });

  test('201: confirmação com o número, itens limpos, trabalhador mantido e "Meus pedidos" atualizado', async () => {
    const { pg } = await abrir();
    const antes = chamadas(pg, 'GET /solicitacoes-epi/minhas').length;
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    await pg.digitar('observacaoPedido', 'x');
    await enviar(pg);
    assert.match(texto(pg, 'avisoNovaSolicitacao'), /Pedido nº 8 enviado/);
    assert.equal(itens(pg).length, 1);
    assert.equal(campo(itens(pg)[0], 'materialId').value, '');
    assert.equal(pg.el('observacaoPedido').value, '');
    assert.equal(pg.visivel('trabalhadorSelecionado'), true);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/minhas').length, antes + 1);
  });

  test('repetição idempotente (200): avisa que já tinha sido enviado; nenhum pedido novo', async () => {
    const { pg } = await abrir({ criar: () => ({ status: 200, corpo: { status: 'ok', repetida: true, solicitacao: { id: 102, numero: 8, status: 'PENDENTE' }, itens: [] } }) });
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    await enviar(pg);
    assert.match(texto(pg, 'avisoNovaSolicitacao'), /já tinha sido enviado[\s\S]*nº 8/);
  });

  test('falha de rede: aviso de resultado incerto; reenviar o mesmo rascunho usa a MESMA chave; mudar o rascunho gera outra', async () => {
    let falhar = true;
    const { pg } = await abrir({ criar: () => (falhar ? new Error('rede') : { status: 201, corpo: { status: 'ok', repetida: false, solicitacao: { id: 102, numero: 8 }, itens: [] } }) });
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    await enviar(pg);
    assert.match(texto(pg, 'avisoNovaSolicitacao'), /não foi possível confirmar/i);
    await enviar(pg);
    const [a, b] = chamadas(pg, 'POST /solicitacoes-epi');
    assert.equal(a.corpo.chaveIdempotencia, b.corpo.chaveIdempotencia);
    await escolher(campo(itens(pg)[0], 'quantidade'), '3');
    falhar = false;
    await enviar(pg);
    assert.notEqual(chamadas(pg, 'POST /solicitacoes-epi')[2].corpo.chaveIdempotencia, a.corpo.chaveIdempotencia);
  });

  test('400 com detalhes: o erro aparece no campo do item certo', async () => {
    const { pg } = await abrir({ criar: () => ({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'body.itens[1].tamanho', codigo: 'TAMANHO_OBRIGATORIO', mensagem: 'x' }] } }) });
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    await pg.clicar('botaoAdicionarItem');
    await preencherItem(pg, 1, { material: 30, tamanho: '40' });
    await enviar(pg);
    assert.match(erro(itens(pg)[1], 'tamanho'), /Informe o tamanho/);
    assert.equal(erro(itens(pg)[0], 'tamanho'), '');
  });

  test('erros do servidor com texto próprio e sem detalhe técnico (409, 404, 403, 500)', async () => {
    const casos = [
      [409, 'MATERIAL_INATIVO', /desativado/],
      [409, 'FUNCIONARIO_INATIVO', /inativo/],
      [404, 'FUNCIONARIO_NAO_ENCONTRADO', /Trabalhador não encontrado/],
      [403, 'PERMISSAO_NEGADA', /permissão/],
      [500, 'ERRO_INTERNO', /Não foi possível concluir/],
    ];
    for (const [status, codigo, esperado] of casos) {
      const { pg } = await abrir({ criar: () => ({ status, corpo: { status: 'error', codigo, message: 'violates constraint em SQL' } }) });
      await selecionarTrabalhador(pg);
      await preencherItem(pg, 0, { material: 31 });
      await enviar(pg);
      assert.match(texto(pg, 'avisoNovaSolicitacao'), esperado, codigo);
      assert.equal(/SQL|constraint/.test(texto(pg, 'avisoNovaSolicitacao')), false, codigo);
    }
  });

  test('EPI desativado entre a escolha e o envio (409): a lista de EPIs é relida e o item volta a pedir o EPI', async () => {
    const { pg, s } = await abrir({ criar: () => ({ status: 409, corpo: { status: 'error', codigo: 'MATERIAL_INATIVO', message: 'x' } }) });
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31, quantidade: '2' });
    const lidas = chamadas(pg, 'GET /solicitacoes-epi/contexto/11/materiais').length;
    s.materiais = { ...MATERIAIS, 11: MATERIAIS[11].filter((m) => m.id !== 31) };
    await enviar(pg);
    assert.match(texto(pg, 'avisoNovaSolicitacao'), /desativado/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/contexto/11/materiais').length, lidas + 1);
    const select = campo(itens(pg)[0], 'materialId');
    assert.deepEqual(select.querySelectorAll('option').map((o) => o.getAttribute('value')), ['', '30', '32']);
    assert.equal(select.value, '');
    assert.equal(campo(itens(pg)[0], 'quantidade').value, '2', 'o resto do item continua');
  });

  test('401 no envio: Portal', async () => {
    const { pg } = await abrir({ criar: () => ({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } }) });
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 31 });
    await enviar(pg);
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('E. meus pedidos', () => {
  test('lista com número, data, trabalhador, situação e resumo; sem a situação derivada do estoque', async () => {
    const { pg } = await abrir();
    const [consulta] = chamadas(pg, 'GET /solicitacoes-epi/minhas');
    assert.equal(new URL(consulta.url).search, '?pagina=1&limite=10');
    const linhas = pg.consulta('#listaPedidos [data-solicitacao-id]');
    assert.equal(linhas.length, 1);
    assert.match(linhas[0].textContent, /Pedido nº 7/);
    assert.match(linhas[0].textContent, /03\/10\/2026/);
    assert.match(linhas[0].textContent, /Ana Sintética/);
    assert.match(linhas[0].textContent, /Pendente/);
    assert.match(linhas[0].textContent, /2 itens · 3 unidades/);
    assert.equal(/Aguardando estoque/.test(texto(pg, 'listaPedidos')), false);
  });

  test('vazio e erro', async () => {
    const vazio = await abrir({ minhas: [] });
    assert.equal(vazio.pg.consulta('#listaPedidos [data-estado="vazio"]').length, 1);
    const { pg, s } = await abrir();
    s.erroMinhas = 500;
    await escolher(pg.el('filtroStatusPedidos'), 'APROVADA');
    await pg.esperar();
    assert.equal(pg.consulta('#listaPedidos [data-estado="erro"]').length, 1);
  });

  test('filtro de situação e paginação pelo contrato', async () => {
    const { pg } = await abrir({ totalMinhas: 25 });
    assert.match(texto(pg, 'paginacaoPedidosTexto'), /Página 1 de 3/);
    assert.equal(pg.el('paginaAnteriorPedidos').disabled, true);
    await pg.clicar('paginaProximaPedidos');
    assert.equal(new URL(chamadas(pg, 'GET /solicitacoes-epi/minhas').at(-1).url).search, '?pagina=2&limite=10');
    await escolher(pg.el('filtroStatusPedidos'), 'CANCELADA');
    await pg.esperar();
    assert.equal(new URL(chamadas(pg, 'GET /solicitacoes-epi/minhas').at(-1).url).search, '?status=CANCELADA&pagina=1&limite=10');
    const opcoes = pg.el('filtroStatusPedidos').querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.deepEqual(opcoes, ['', 'PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('F. detalhe', () => {
  test('abre pelo pedido: trabalhador, materiais, tamanho, quantidade, motivo, justificativa, solicitante; sem CPF, e-mail ou estoque', async () => {
    const { pg } = await abrir();
    await pg.consulta('#listaPedidos [data-solicitacao-id]')[0].disparar('click');
    await pg.esperar();
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/101').length, 1);
    assert.equal(pg.visivel('detalhePedido'), true);
    const t = texto(pg, 'detalhePedido');
    for (const esperado of ['Pedido nº 7', 'Pendente', 'Ana Sintética', 'M-011', 'Fundição', 'Operadora', 'Botina de segurança', '40', 'Desgaste ou dano', 'Capacete', 'Outro', 'Capacete trincado', 'Pessoa Solicitante', 'Turno da noite']) {
      assert.ok(t.includes(esperado), esperado);
    }
    assert.equal(/52998224725|example\.invalid|@|Aguardando estoque|\b88\b|cobertura|saldo/i.test(t), false);
  });

  test('estados: aprovado com a quantidade, reprovado com a justificativa da SST, cancelado com o motivo', async () => {
    for (const [status, esperado] of [['APROVADA', /Aprovado: 2/], ['REPROVADA', /Reprovado[\s\S]*Troca recente/], ['CANCELADA', /Cancelado[\s\S]*Pedido em duplicidade/]]) {
      const { pg } = await abrir({ detalhe: detalheDe(status) });
      await pg.consulta('#listaPedidos [data-solicitacao-id]')[0].disparar('click');
      await pg.esperar();
      assert.match(texto(pg, 'detalhePedido'), esperado, status);
      assert.equal(pg.visivel('botaoCancelarPedido'), false, `${status}: sem cancelar`);
    }
  });

  test('não encontrado: a mesma mensagem genérica', async () => {
    const { pg } = await abrir({ detalhe: { status: 404, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_ENCONTRADA', message: 'outra coisa' } } });
    await pg.consulta('#listaPedidos [data-solicitacao-id]')[0].disparar('click');
    await pg.esperar();
    assert.match(texto(pg, 'detalhePedido'), /Solicitação não encontrada\./);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('G. cancelamento', () => {
  const abrirDetalhe = async (pg) => { await pg.consulta('#listaPedidos [data-solicitacao-id]')[0].disparar('click'); await pg.esperar(); };

  test('oferecido só com request.editar e pedido pendente; pede confirmação; "Voltar" não envia nada', async () => {
    const semEditar = await abrir({ p: permissoes({ request: { ...TODAS, editar: false } }) });
    await abrirDetalhe(semEditar.pg);
    assert.equal(semEditar.pg.visivel('botaoCancelarPedido'), false);
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    assert.equal(pg.visivel('botaoCancelarPedido'), true);
    await pg.clicar('botaoCancelarPedido');
    assert.equal(pg.visivel('confirmacaoCancelamento'), true);
    assert.equal(pg.el('justificativaCancelamento').getAttribute('maxlength'), String(JUSTIFICATIVA_CANCELAMENTO));
    await pg.clicar('botaoVoltarCancelamento');
    assert.equal(pg.visivel('confirmacaoCancelamento'), false);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi/101/cancelamento').length, 0);
  });

  test('confirmado: POST com a justificativa (vazia = null), recarrega o detalhe e a lista e some o botão', async () => {
    const { pg, s } = await abrir();
    await abrirDetalhe(pg);
    await pg.clicar('botaoCancelarPedido');
    await pg.digitar('justificativaCancelamento', '  ');
    s.detalhe = detalheDe('CANCELADA');
    const listas = chamadas(pg, 'GET /solicitacoes-epi/minhas').length;
    await pg.clicar('botaoConfirmarCancelamento');
    await pg.esperar();
    assert.deepEqual(chamadas(pg, 'POST /solicitacoes-epi/101/cancelamento')[0].corpo, { justificativa: null });
    assert.match(texto(pg, 'avisoDetalhe'), /Pedido nº 7 cancelado/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/101').length, 2);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/minhas').length, listas + 1);
    assert.equal(pg.visivel('botaoCancelarPedido'), false);
  });

  test('o servidor recusa porque o estado mudou (409): mensagem e o detalhe é recarregado', async () => {
    const { pg, s } = await abrir({ cancelar: () => ({ status: 409, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_PENDENTE', message: 'x' } }) });
    await abrirDetalhe(pg);
    s.detalhe = detalheDe('APROVADA');
    await pg.clicar('botaoCancelarPedido');
    await pg.clicar('botaoConfirmarCancelamento');
    await pg.esperar();
    assert.match(texto(pg, 'avisoDetalhe'), /já foi decidido ou cancelado/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/101').length, 2);
    assert.equal(pg.visivel('botaoCancelarPedido'), false);
  });

  test('com o cancelamento em andamento: botão ocupado; nem reabilitado ele gera um segundo POST', async () => {
    const { pg, s } = await abrir();
    await abrirDetalhe(pg);
    await pg.clicar('botaoCancelarPedido');
    s.pendente.cancelar = true;
    pg.el('botaoConfirmarCancelamento').disparar('click');
    await pg.esperar();
    assert.equal(pg.el('botaoConfirmarCancelamento').disabled, true);
    assert.equal(pg.el('botaoConfirmarCancelamento').getAttribute('aria-busy'), 'true');
    pg.el('botaoConfirmarCancelamento').disabled = false;
    pg.el('botaoConfirmarCancelamento').disparar('click');
    await pg.esperar();
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi/101/cancelamento').length, 1);
    s.pendente.cancelar();
    await pg.esperar();
    assert.equal(pg.el('botaoConfirmarCancelamento').getAttribute('aria-busy'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('H. permissões efetivas', () => {
  test('só criar: formulário sem "Meus pedidos" (nenhuma consulta da lista)', async () => {
    const { pg } = await abrir({ p: permissoes({ request: { ...NENHUMA, criar: true } }) });
    assert.equal(pg.visivel('cardNovaSolicitacao'), true);
    assert.equal(pg.visivel('cardMeusPedidos'), false);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/minhas').length, 0);
  });

  test('só visualizar: "Meus pedidos" sem formulário (nenhuma consulta de trabalhador)', async () => {
    const { pg } = await abrir({ p: permissoes({ request: { ...NENHUMA, visualizar: true } }) });
    assert.equal(pg.visivel('cardNovaSolicitacao'), false);
    assert.equal(pg.visivel('cardMeusPedidos'), true);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/contexto/funcionarios').length, 0);
  });

  test('MASTER com request concedido de verdade usa a tela; o perfil não dá nem tira nada', async () => {
    const { pg } = await abrir({ p: permissoes({ perfil: 'MASTER', request: { ...NENHUMA, visualizar: true, criar: true } }) });
    assert.equal(pg.visivel('cardNovaSolicitacao'), true);
    assert.equal(pg.visivel('cardMeusPedidos'), true);
    await pg.consulta('#listaPedidos [data-solicitacao-id]')[0].disparar('click');
    await pg.esperar();
    assert.equal(pg.visivel('botaoCancelarPedido'), false, 'sem request.editar, o MASTER não cancela');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('I. sessão', () => {
  test('401 ao listar: Portal, nada protegido à mostra', async () => {
    const { s, rotas } = servidor();
    s.erroMinhas = 401;
    const pg = abrirPagina('pages/request.html', { rotas });
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('volta pelo histórico com permissões alteradas: rascunho e listas somem antes de recarregar', async () => {
    const { pg, s } = await abrir();
    await selecionarTrabalhador(pg);
    s.p = permissoes({ request: { ...NENHUMA, visualizar: true } });
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.deepEqual(pg.navegacoes, ['/pages/request.html']);
    assert.equal(itens(pg).length, 0);
    assert.equal(pg.consulta('#listaPedidos [data-solicitacao-id]').length, 0);
  });

  test('sessão trocada com o aviso de EPIs não classificados na tela: o aviso também some', async () => {
    const pendente = { id: 60, nome: 'Botina teste ramires', unidade: 'par', exigeTamanho: null, previstoNoGhe: true, tamanhosSugeridos: [] };
    const { pg, s } = await abrir({ materiais: { ...MATERIAIS, 11: [...MATERIAIS[11], pendente] } });
    await selecionarTrabalhador(pg);
    assert.match(texto(pg, 'materiaisPendentes'), /Botina teste ramires/);
    s.p = permissoes({ request: { ...NENHUMA, visualizar: true } });
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.equal(texto(pg, 'materiaisPendentes'), '');
    assert.equal(pg.textoDoDom().includes('Botina teste ramires'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('J. semântica, acessibilidade e segurança', () => {
  test('nada de "Em integração" no Pedido de EPI; controles ativos conforme o estado', async () => {
    const html = ler('pages/request.html');
    assert.equal(/Em integração|data-area-integracao|data-estado-area/.test(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<nav class="nav">[\s\S]*?<\/nav>/, '')), false);
    const { pg } = await abrir();
    assert.equal(pg.visivel('blocoItens'), false, 'sem trabalhador, sem itens');
    await selecionarTrabalhador(pg);
    for (const id of ['botaoAdicionarItem', 'botaoLimparPedido', 'botaoEnviarPedido']) assert.equal(pg.el(id).disabled, false, id);
  });

  test('todo campo tem rótulo associado; erros ligados ao campo por aria-describedby', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await enviar(pg);
    const campos = pg.consulta('#cardNovaSolicitacao input, #cardNovaSolicitacao select, #cardNovaSolicitacao textarea, #cardMeusPedidos select').filter(pg.visivelNo);
    for (const c of campos) {
      const id = c.getAttribute('id');
      assert.ok(id && pg.consulta(`label[for="${id}"]`).length === 1, `rótulo de ${id}`);
    }
    const material = campo(itens(pg)[0], 'materialId');
    assert.equal(material.getAttribute('aria-invalid'), 'true');
    assert.ok(pg.documento.getElementById(material.getAttribute('aria-describedby').split(' ').pop()));
  });

  test('HTML vindo do servidor é sempre texto (trabalhador, EPI e detalhe); nada passa por innerHTML; nada no armazenamento', async () => {
    const ATAQUE = '<img src=x onerror=alert(1)>';
    const { s, rotas } = servidor({ minhas: [linha({ funcionario: { id: 11, nome: ATAQUE, matricula: ATAQUE, ativo: true } })], detalhe: detalheDe('PENDENTE', { observacao: ATAQUE }) });
    s.trabalhadores = [{ id: 11, nome: ATAQUE, matricula: 'M-1', setor: ATAQUE, funcao: null }];
    s.materiais = { ...MATERIAIS, 11: [{ id: 30, nome: ATAQUE, unidade: ATAQUE, exigeTamanho: true, previstoNoGhe: true, tamanhosSugeridos: [ATAQUE] }] };
    const pg = abrirPagina('pages/request.html', { rotas });
    await pg.esperar();
    await selecionarTrabalhador(pg, 'M-1');
    await escolher(campo(itens(pg)[0], 'materialId'), 30);
    await pg.consulta('#listaPedidos [data-solicitacao-id]')[0].disparar('click');
    await pg.esperar();
    assert.equal(pg.consulta('img').length, 0);
    assert.ok(pg.textoDoDom().includes(ATAQUE), 'o texto aparece como texto');
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    // Só o cache de pintura da aparência (js/tema.js, Configurações) toca o armazenamento; nada da página.
    assert.deepEqual(pg.storage.filter((x) => !(x.operacao === 'removeItem' || x.storage === 'cookie' || x.chave === 'safework-aparencia')), []);
  });

  test('os itens cabem no cartão (estilo que vence na cascata): colunas que encolhem, campos na largura da coluna, "Remover" do tamanho do conteúdo', async () => {
    const { pg } = await abrir();
    await selecionarTrabalhador(pg);
    await preencherItem(pg, 0, { material: 30, tamanho: '40', motivo: 'OUTRO', justificativa: 'x' });
    const item = itens(pg)[0];
    const css = (el, props) => estiloComputado(pg, 'pages/request.html', el, props);
    assert.equal(String(css(item, ['grid-template-columns'])['grid-template-columns']).replace(/\s+/g, ' '), 'repeat(2, minmax(0, 1fr))', 'a coluna não cresce com o nome do EPI');
    for (const nome of ['materialId', 'tamanho', 'quantidade', 'motivo', 'justificativa']) {
      const c = campo(item, nome);
      const e = css(c, ['width', 'min-width']);
      assert.deepEqual([e.width, e['min-width']], ['100%', '0'], `${nome}: ${JSON.stringify(e)}`);
      assert.equal(css(c.parentElement, ['min-width'])['min-width'], '0', `coluna de ${nome}`);
    }
    assert.equal(css(item.querySelector('.epi-item-actions'), ['flex-direction'])['flex-direction'], 'row', '"Remover" não estica na linha inteira');
  });

  for (const tema of ['light', 'dark']) {
    test(`botão desabilitado parece desabilitado (tema ${tema}): cinza, apagado, sem o azul de ação e com cursor de bloqueio, também sob o mouse`, async () => {
      const pendente = { id: 60, nome: 'Botina teste ramires', unidade: 'par', exigeTamanho: null, previstoNoGhe: true, tamanhosSugeridos: [] };
      const { pg } = await abrir({ materiais: { ...MATERIAIS, 11: [pendente] } });
      await selecionarTrabalhador(pg);
      pg.documento.documentElement.setAttribute('data-theme', tema);
      const tk = (nome) => token(pg, 'pages/request.html', nome);
      const azul = tk('--primary').toLowerCase();
      for (const id of ['botaoEnviarPedido', 'botaoAdicionarItem', 'paginaAnteriorPedidos']) {
        const botao = pg.el(id);
        assert.equal(botao.disabled, true, id);
        for (const hover of [false, true]) {
          const e = estiloComputado(pg, 'pages/request.html', botao, ['opacity', 'cursor', 'color', 'background', 'border', 'box-shadow'], { hover });
          const onde = `${id} ${tema}${hover ? ' (mouse em cima)' : ''}: ${JSON.stringify(e)}`;
          assert.ok(Number(e.opacity) <= 0.6, onde);
          assert.equal(e.cursor, 'not-allowed', onde);
          assert.deepEqual([e.color, e.background], [tk('--on-surface-variant'), tk('--surface-container-high')], onde);
          for (const p of ['color', 'background', 'border']) assert.equal(String(e[p]).toLowerCase().includes(azul), false, `${onde} — ${p}`);
        }
      }
    });

    test(`situação em "Meus pedidos" com o tom dela (tema ${tema}): pendente em âmbar, aprovada e entregue em verde, reprovada em vermelho, cancelada e encerrada neutras`, async () => {
      const status = ['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'ENTREGUE', 'REPROVADA', 'CANCELADA', 'ENCERRADA'];
      const tom = { PENDENTE: 'aviso', APROVADA: 'ok', APROVADA_PARCIAL: 'ok', ENTREGUE: 'ok', REPROVADA: 'perigo', CANCELADA: 'neutro', ENCERRADA: 'neutro' };
      const { pg } = await abrir({ minhas: status.map((st, i) => linha({ id: 200 + i, numero: 20 + i, status: st })) });
      pg.documento.documentElement.setAttribute('data-theme', tema);
      const tk = (nome) => token(pg, 'pages/request.html', nome);
      const escuro = tema === 'dark';
      const esperado = {
        aviso: [escuro ? tk('--warning') : '#C07000', tk('--warning-container')],
        ok: [escuro ? tk('--success') : '#1A7A35', tk('--success-container')],
        perigo: [escuro ? '#FF6961' : '#C0221A', tk('--error-container')],
        neutro: [tk('--on-surface-variant'), tk('--surface-container-highest')],
      };
      const selos = pg.consulta('#listaPedidos .request-status');
      assert.equal(selos.length, status.length);
      selos.forEach((selo, i) => {
        const e = estiloComputado(pg, 'pages/request.html', selo, ['color', 'background']);
        assert.deepEqual([e.color, e.background], esperado[tom[status[i]]], `${status[i]} (${tema}): ${JSON.stringify(e)}`);
      });
    });
  }
});
