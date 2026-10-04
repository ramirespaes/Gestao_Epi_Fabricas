'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const { estiloComputado, token } = require('./helpers/estilo-computado');

/**
 * 12G-4 — Entregas por solicitação (pages/stock-requests.html +
 * js/entregas-solicitacao.js) sobre os contratos da 12F e da 12G-0: a lista
 * (entregáveis para quem entrega; encerráveis para quem só encerra), o
 * detalhe com a cobertura, os lotes do contexto da entrega, a entrega por
 * solicitação (idempotente, com a confirmação do trabalhador) e o
 * encerramento. A tela não decide solicitação; a autoridade é a efetiva
 * (REALIZAR_ENTREGA e ENCERRAR_SOLICITACAO), nunca o perfil.
 */

const RAIZ = path.join(__dirname, '..');
const PAGINA = 'pages/stock-requests.html';

function modulo() {
  assert.ok(fs.existsSync(path.join(RAIZ, 'js/entregas-solicitacao.js')), 'comportamento ausente: js/entregas-solicitacao.js (a tela de Entregas por solicitação) não existe');
  require('../js/solicitacoes-epi'); // eslint-disable-line global-require
  require('../js/epi-ficha'); // eslint-disable-line global-require
  return require('../js/entregas-solicitacao'); // eslint-disable-line global-require
}

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const AMBAS = { REALIZAR_ENTREGA: true, ENCERRAR_SOLICITACAO: true };
function permissoes({ perfil = 'ADMINISTRADOR', acoes = AMBAS } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil, recursos: { request: NENHUMA }, acoes,
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}

const linha = (extra = {}) => ({
  id: 301, numero: 41, status: 'APROVADA_PARCIAL', situacaoOperacional: 'PARCIALMENTE_COBERTA', solicitanteUsuarioId: 9,
  funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', ativo: true }, quantidadeItens: 3,
  quantidades: { solicitada: 6, aprovada: 4, entregue: 1, restante: 3 }, criadaEm: '2026-10-02T13:05:00.000Z', decididaEm: '2026-10-03T12:00:00.000Z', canceladaEm: null, entregueEm: null,
  ...extra,
});
const linhaEncerravel = (extra = {}) => {
  const { situacaoOperacional, solicitanteUsuarioId, canceladaEm, entregueEm, ...resto } = linha(extra);
  void situacaoOperacional; void solicitanteUsuarioId; void canceladaEm; void entregueEm;
  return resto;
};
const ITEM_BOTINA = {
  id: 11, materialId: 30, tamanho: '40', quantidade: 3, motivo: 'DESGASTE_DANO', justificativa: null, previstoNoGhe: true,
  decisao: 'APROVADO', quantidadeAprovada: 2, justificativaDecisao: 'Um par basta', quantidadeEntregue: 0, quantidadePendente: 2, situacao: 'PRONTA_PARA_ENTREGA',
  cobertura: { coberta: 2, semCobertura: 0, acumuladoAnterior: 0, fisicoUtilizavel: 6 },
  posicao: { fisicoUtilizavel: 6, demandaPendente: 2, comprometido: 2, saldoLivre: 4, semCobertura: 0 },
  material: { nome: 'Botina de segurança', unidade: 'par' },
};
const ITEM_CAPACETE = {
  id: 12, materialId: 31, tamanho: null, quantidade: 2, motivo: 'ADMISSAO', justificativa: null, previstoNoGhe: true,
  decisao: 'APROVADO', quantidadeAprovada: 2, justificativaDecisao: null, quantidadeEntregue: 1, quantidadePendente: 1, situacao: 'PARCIALMENTE_ENTREGUE',
  cobertura: { coberta: 0, semCobertura: 1, acumuladoAnterior: 0, fisicoUtilizavel: 0 },
  posicao: { fisicoUtilizavel: 0, demandaPendente: 1, comprometido: 0, saldoLivre: 0, semCobertura: 1 },
  material: { nome: 'Capacete de segurança', unidade: 'unidade' },
};
const ITEM_LUVA = {
  id: 13, materialId: 32, tamanho: 'M', quantidade: 1, motivo: 'OUTRO', justificativa: 'Corte', previstoNoGhe: false,
  decisao: 'REPROVADO', quantidadeAprovada: 0, justificativaDecisao: 'Fora da política', quantidadeEntregue: 0, quantidadePendente: null, situacao: null,
  cobertura: null, posicao: null, material: { nome: 'Luva de vaqueta', unidade: 'par' },
};
function detalheDe({ status = 'APROVADA_PARCIAL', itens = [ITEM_BOTINA, ITEM_CAPACETE, ITEM_LUVA], situacao = 'PARCIALMENTE_COBERTA' } = {}) {
  return {
    status: 'ok',
    solicitacao: {
      id: 301, numero: 41, status, origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 9, funcionarioId: 11, gheId: 2, quantidadeItens: itens.length,
      observacao: 'Troca antes da parada.', criadaEm: '2026-10-02T13:05:00.000Z',
      decisao: { decididaPor: 5, decididaEm: '2026-10-03T12:00:00.000Z', decisor: { id: 5, nome: 'Diego SST' } },
      cancelamento: null, entregueEm: null, encerramento: null, situacaoOperacional: situacao,
      quantidades: { solicitada: 6, aprovada: 4, entregue: 1, restante: 3 },
      funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', setor: 'Fundição', funcao: 'Operadora de forno', ativo: true, cpf: '52998224725' },
      solicitante: { id: 9, nome: 'Luis Solicitante', email: 'luis@example.invalid' },
    },
    itens,
  };
}
// Lotes do material 30 na ordem do servidor (validade do CA): o de outro tamanho e o de CA vencido não servem ao item.
const LOTES_BOTINA = [
  { loteId: 501, tamanho: '40', caNumero: '12345', caValidade: '2027-01-31', saldo: 1, situacaoCa: 'VALIDO' },
  { loteId: 503, tamanho: '41', caNumero: '12345', caValidade: '2027-03-31', saldo: 9, situacaoCa: 'VALIDO' },
  { loteId: 502, tamanho: '40', caNumero: '12345', caValidade: '2027-06-30', saldo: 5, situacaoCa: 'VALIDO' },
  { loteId: 504, tamanho: '40', caNumero: '99999', caValidade: '2026-01-01', saldo: 3, situacaoCa: 'VENCIDO' },
];

function servidor({
  p = permissoes(), lista = [linha()], totalLista = null, encerraveis = [linhaEncerravel()], detalhe = detalheDe(), lotes = LOTES_BOTINA, entregar = null, encerrar = null,
} = {}) {
  const s = {
    p, lista, totalLista, encerraveis, detalhe, lotes, entregar, encerrar, pendente: {},
  };
  const corpo = (status, c) => ({ status, corpo: c });
  const segurar = (nome, resposta) => (s.pendente[nome] ? new Promise((r) => { s.pendente[nome] = () => { s.pendente[nome] = false; r(resposta()); }; }) : resposta());
  const pagina = (c) => { const u = new URL(c.url).searchParams; return { pagina: Number(u.get('pagina')), limite: Number(u.get('limite')) }; };
  const rotas = {
    'GET /auth/me': () => corpo(200, { status: 'ok', usuario: { id: 7, nome: 'Eva do Almoxarifado', email: 'eva@example.invalid', perfil: s.p.perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }),
    'GET /auth/global/me': () => corpo(200, { status: 'ok', empresas: [{ id: 3 }] }),
    'GET /auth/permissoes': () => segurar('permissoes', () => corpo(200, s.p)),
    'GET /solicitacoes-epi/entregaveis': (c) => segurar('lista', () => (s.erroLista ? corpo(s.erroLista, { status: 'error', codigo: 'X', message: 'falha interna em SQL' })
      : corpo(200, { status: 'ok', solicitacoes: s.lista, total: s.totalLista ?? s.lista.length, ...pagina(c) }))),
    'GET /solicitacoes-epi/encerraveis': (c) => corpo(200, { status: 'ok', solicitacoes: s.encerraveis, total: s.encerraveis.length, ...pagina(c) }),
    'GET /solicitacoes-epi/301': () => segurar('detalhe', () => (typeof s.detalhe === 'function' ? s.detalhe() : corpo(200, s.detalhe))),
    'GET /solicitacoes-epi/302': () => corpo(404, { status: 'error', codigo: 'SOLICITACAO_NAO_ENCONTRADA', message: 'Solicitação não encontrada' }),
    'GET /entregas-epi/contexto/11/materiais/30/lotes': () => segurar('lotes', () => (s.erroLotes ? s.erroLotes
      : corpo(200, { status: 'ok', material: { id: 30, nome: 'Botina de segurança', ativo: true, exigeTamanho: true }, hoje: '2026-10-04', lotes: s.lotes, posicoes: [] }))),
    'POST /solicitacoes-epi/301/entregas': (c) => segurar('entregar', () => (s.entregar ? s.entregar(c)
      : corpo(201, { status: 'ok', repetida: false, entrega: { id: 9001, ficha: { id: 77, numero: 12, funcionarioId: 11 } }, solicitacao: { id: 301, numero: 41, status: 'APROVADA_PARCIAL' } }))),
    'POST /solicitacoes-epi/301/encerramento': (c) => segurar('encerrar', () => (s.encerrar ? s.encerrar(c)
      : corpo(200, { status: 'ok', solicitacao: { id: 301, numero: 41, status: 'ENCERRADA' }, itens: [] }))),
  };
  return { s, rotas };
}

async function abrir(opcoes = {}) {
  modulo();
  const { s, rotas } = servidor(opcoes);
  const pg = abrirPagina(PAGINA, { rotas });
  await pg.esperar();
  return { pg, s };
}
const chamadas = (pg, chave) => pg.chamadas.filter((c) => c.chave === chave);
const texto = (pg, id) => pg.el(id).textContent;
const linhas = (pg) => pg.consulta('#listaEntregas [data-solicitacao-id]');
async function abrirDetalhe(pg, id = 301) {
  const b = pg.consulta(`#listaEntregas [data-solicitacao-id="${id}"]`)[0];
  assert.ok(b, `pedido ${id} na lista`);
  await b.disparar('click');
  await pg.esperar();
}
const cartao = (pg, itemId) => pg.consulta(`#detalheItens [data-item-id="${itemId}"]`)[0];
const loteCampo = (pg, loteId) => pg.consulta(`#entregaItens [data-lote-id="${loteId}"] input`)[0];
const erroDoItem = (pg, itemId) => { const e = pg.consulta(`#entregaItens [data-item-id="${itemId}"] [data-erro="item"]`)[0]; return e ? e.textContent : ''; };
const erroDoLote = (pg, loteId) => { const e = pg.consulta(`#entregaItens [data-lote-id="${loteId}"] [data-erro="quantidade"]`)[0]; return e ? e.textContent : ''; };
async function quantidade(pg, loteId, valor) {
  const c = loteCampo(pg, loteId);
  assert.ok(c, `campo do lote ${loteId}`);
  c.value = String(valor);
  await c.disparar('input');
  await pg.esperar();
}
async function prepararEntrega(pg) { await pg.clicar('botaoPrepararEntrega'); await pg.esperar(); }
async function aceitar(pg) {
  const modo = pg.consulta('input[name="modoConfirmacao"][value="ACEITE_PRESENCIAL"]')[0];
  modo.checked = true;
  await modo.disparar('change');
  await pg.marcar('aceitePresencial', true);
  await pg.esperar();
}
const registrar = async (pg) => { await pg.clicar('botaoRegistrarEntrega'); await pg.esperar(); };
const entregas = (pg) => chamadas(pg, 'POST /solicitacoes-epi/301/entregas');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────
describe('1–2. lista de entregáveis', () => {
  test('lista do servidor (sem empresa nem usuário na consulta): número, data, trabalhador, matrícula, decisão da SST, situação e quantidades; nunca CPF', async () => {
    const { pg } = await abrir();
    const c = chamadas(pg, 'GET /solicitacoes-epi/entregaveis');
    assert.equal(c.length, 1);
    assert.equal(new URL(c[0].url).search, '?pagina=1&limite=20');
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/encerraveis').length, 0, 'quem entrega usa os entregáveis');
    const t = linhas(pg)[0].textContent;
    for (const e of [/Pedido nº 41/, /02\/10\/2026/, /Ana Sintética/, /M-011/, /Aprovada parcialmente/, /Disponível em parte/, /Aprovadas 4/, /Entregues 1/, /Restantes 3/, /Encerrável/]) assert.match(t, e);
    assert.equal(/52998224725|CPF/i.test(pg.textoDoDom()), false);
    assert.equal(/Em integração/.test(texto(pg, 'conteudoProtegido')), false, 'a tela funcional não tem área "em integração"');
  });

  test('lista vazia: estado claro; o detalhe espera uma escolha', async () => {
    const { pg } = await abrir({ lista: [] });
    assert.equal(pg.consulta('#listaEntregas [data-estado="vazio"]').length, 1);
    assert.match(texto(pg, 'listaEntregas'), /Não há solicitações aprovadas aguardando entrega\./);
    assert.equal(pg.visivel('detalheConteudo'), false);
  });

  test('erro ao carregar: sem texto técnico; "Atualizar" consulta de novo; paginação com "Anterior" desabilitado na primeira página', async () => {
    const { pg, s } = await abrir({ totalLista: 25 });
    assert.match(texto(pg, 'listaPaginacaoTexto'), /Página 1 de 2/);
    assert.equal(pg.el('listaAnterior').disabled, true);
    s.erroLista = 500;
    await pg.clicar('botaoAtualizarLista');
    assert.equal(pg.consulta('#listaEntregas [data-estado="erro"]').length, 1);
    assert.equal(/SQL/.test(texto(pg, 'listaEntregas')), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('3–10. detalhe real e situação de cada item', () => {
  test('detalhe: trabalhador, matrícula, setor, função, solicitante, criação, decisão da SST e observação; sem CPF nem e-mail', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/301').length, 1);
    assert.match(texto(pg, 'detalheTitulo'), /Pedido nº 41/);
    const r = texto(pg, 'detalheResumo');
    for (const e of [/Ana Sintética/, /M-011/, /Fundição/, /Operadora de forno/, /Luis Solicitante/, /02\/10\/2026/, /Aprovada parcialmente/, /Diego SST/, /Troca antes da parada\./, /Disponível em parte/]) assert.match(r, e);
    assert.equal(/52998224725|example\.invalid|@/.test(texto(pg, 'conteudoProtegido')), false);
    assert.equal(pg.foco(), 'detalheTitulo');
  });

  test('item com tamanho e item sem tamanho; aprovada, entregue e pendente com a unidade', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    const botina = cartao(pg, 11).textContent;
    for (const e of [/Botina de segurança/, /Tamanho: 40/, /Solicitada: 3 par/, /Aprovada: 2 par/, /Entregue: 0 par/, /Pendente: 2 par/]) assert.match(botina, e);
    const capacete = cartao(pg, 12).textContent;
    for (const e of [/Não usa tamanho/, /Aprovada: 2 unidade/, /Entregue: 1 unidade/, /Pendente: 1 unidade/]) assert.match(capacete, e);
  });

  test('disponível com estoque e aguardando estoque, pela cobertura do servidor (sem recalcular no navegador); reprovado só informado', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    assert.match(cartao(pg, 11).querySelector('[data-situacao]').textContent, /Disponível para entrega/);
    assert.match(cartao(pg, 11).textContent, /Disponível agora: 2 par/);
    assert.match(cartao(pg, 12).querySelector('[data-situacao]').textContent, /Parcialmente entregue/);
    assert.match(cartao(pg, 12).textContent, /Aguardando estoque: 1 unidade/);
    assert.match(cartao(pg, 13).textContent, /Reprovado pela Segurança do Trabalho/);
    assert.equal(/Disponível agora/.test(cartao(pg, 13).textContent), false);
  });

  test('item suspenso (trabalhador ou EPI inativo): situação própria e nada a entregar', async () => {
    const suspenso = { ...ITEM_BOTINA, situacao: 'SUSPENSA', cobertura: null, posicao: null };
    const { pg } = await abrir({ detalhe: detalheDe({ itens: [suspenso], situacao: 'SUSPENSA' }) });
    await abrirDetalhe(pg);
    assert.match(cartao(pg, 11).querySelector('[data-situacao]').textContent, /Suspensa/);
    assert.equal(pg.el('botaoPrepararEntrega').disabled, true);
  });

  test('a solicitação que já não aguarda entrega (entregue por outra operação) ao abrir: aviso, sem ações, lista relida', async () => {
    const { pg } = await abrir({ detalhe: detalheDe({ status: 'ENTREGUE', situacao: 'ENTREGUE', itens: [{ ...ITEM_BOTINA, quantidadeEntregue: 2, quantidadePendente: 0, situacao: 'ENTREGUE', cobertura: null }] }) });
    await abrirDetalhe(pg);
    assert.match(texto(pg, 'avisoDetalhe'), /não aguarda mais entrega/);
    assert.equal(pg.visivel('botaoPrepararEntrega'), false);
    assert.equal(pg.visivel('botaoEncerrar'), false);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('11–17. entrega', () => {
  test('preparar: só os itens com algo disponível agora pedem lotes; os lotes servem só ao tamanho do item, com CA válido, na ordem do servidor (FIFO pela validade do CA)', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    assert.equal(chamadas(pg, 'GET /entregas-epi/contexto/11/materiais/30/lotes').length, 1);
    assert.equal(pg.chamadas.filter((c) => /\/materiais\/31\/lotes/.test(c.chave)).length, 0, 'o item aguardando estoque não pede lotes');
    const ordem = pg.consulta('#entregaItens [data-lote-id]').map((l) => l.getAttribute('data-lote-id'));
    assert.deepEqual(ordem, ['501', '502'], 'sem o lote de outro tamanho e sem o de CA vencido, na ordem recebida');
    assert.match(pg.consulta('#entregaItens [data-lote-id="501"]')[0].textContent, /CA 12345[\s\S]*31\/01\/2027[\s\S]*Saldo: 1/);
  });

  test('sugestão FIFO: preenche o lote que vence primeiro até o saldo e segue para o próximo, até o disponível agora', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    assert.deepEqual([loteCampo(pg, 501).value, loteCampo(pg, 502).value], ['1', '1']);
    assert.deepEqual([loteCampo(pg, 501).getAttribute('max'), loteCampo(pg, 502).getAttribute('max')], ['1', '2']);
  });

  test('entrega integral com aceite presencial: um POST com os lotes, a confirmação e a chave; sucesso relê o detalhe e a lista', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.equal(entregas(pg).length, 1);
    const corpo = entregas(pg)[0].corpo;
    assert.deepEqual(corpo.itens, [{ solicitacaoItemId: 11, loteId: 501, quantidade: 1 }, { solicitacaoItemId: 11, loteId: 502, quantidade: 1 }]);
    const F = require('../js/epi-ficha'); // eslint-disable-line global-require
    assert.deepEqual(corpo.confirmacao, { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: F.DECLARACAO.versao, declaracaoTexto: F.DECLARACAO.texto });
    assert.match(corpo.chaveIdempotencia, UUID);
    assert.equal(/empresa|usuario|funcionarioId|responsavel/i.test(JSON.stringify(Object.keys(corpo))), false);
    assert.match(texto(pg, 'avisoDetalhe'), /Entrega registrada[\s\S]*ficha nº 12/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/301').length, 2, 'o detalhe foi relido');
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 2, 'a lista foi relida');
    assert.equal(pg.visivel('painelEntrega'), false);
  });

  test('entrega parcial: zerar um lote envia só o outro', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await quantidade(pg, 502, '0');
    await aceitar(pg);
    await registrar(pg);
    assert.deepEqual(entregas(pg)[0].corpo.itens, [{ solicitacaoItemId: 11, loteId: 501, quantidade: 1 }]);
  });

  test('acima do saldo do lote, acima do disponível agora, decimal ou negativo: erro no lugar certo e nada enviado; nada informado também não envia', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await quantidade(pg, 501, '3');
    await registrar(pg);
    assert.match(erroDoLote(pg, 501), /Este lote tem só 1/);
    await quantidade(pg, 501, '1');
    await quantidade(pg, 502, '2');
    await registrar(pg);
    assert.match(erroDoItem(pg, 11), /disponível agora para este item é 2/);
    for (const v of ['1.5', '-1', 'x']) {
      await quantidade(pg, 502, v);
      await registrar(pg);
      assert.match(erroDoLote(pg, 502), /inteira/, v);
    }
    await quantidade(pg, 501, '0');
    await quantidade(pg, 502, '0');
    await registrar(pg);
    assert.match(texto(pg, 'avisoEntrega'), /pelo menos um lote/);
    assert.equal(entregas(pg).length, 0);
  });

  test('sem a confirmação do trabalhador nada é enviado; mudar a entrega depois da confirmação exige uma nova', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await registrar(pg);
    assert.match(texto(pg, 'avisoEntrega'), /confirmação do trabalhador/);
    await aceitar(pg);
    await quantidade(pg, 502, '0');
    assert.equal(pg.el('aceitePresencial').checked, false, 'a confirmação anterior foi descartada');
    assert.match(texto(pg, 'avisoEntrega'), /mudou depois da confirmação/);
    await registrar(pg);
    assert.equal(entregas(pg).length, 0);
  });

  test('trocar o modo de confirmação descarta a anterior: o aceite marcado não vai no lugar da assinatura nem volta marcado', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    const desenho = pg.consulta('input[name="modoConfirmacao"][value="DESENHO"]')[0];
    desenho.checked = true;
    await desenho.disparar('change');
    await registrar(pg);
    assert.equal(entregas(pg).length, 0);
    assert.match(texto(pg, 'avisoEntrega'), /confirmação do trabalhador/);
    const aceite = pg.consulta('input[name="modoConfirmacao"][value="ACEITE_PRESENCIAL"]')[0];
    aceite.checked = true;
    await aceite.disparar('change');
    assert.equal(pg.el('aceitePresencial').checked, false);
  });

  test('clique duplo, e até o botão reabilitado: um só POST; botão ocupado enquanto o servidor responde', async () => {
    const { pg, s } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    s.pendente.entregar = true;
    pg.el('botaoRegistrarEntrega').disparar('click');
    pg.el('botaoRegistrarEntrega').disparar('click');
    await pg.esperar();
    assert.equal(pg.el('botaoRegistrarEntrega').disabled, true);
    assert.equal(pg.el('botaoRegistrarEntrega').getAttribute('aria-busy'), 'true');
    pg.el('botaoRegistrarEntrega').disabled = false;
    pg.el('botaoRegistrarEntrega').disparar('click');
    await pg.esperar();
    assert.equal(entregas(pg).length, 1);
    s.pendente.entregar();
    await pg.esperar();
  });

  test('idempotência: falha de rede trava a entrega como incerta; "Tentar novamente" reenvia o MESMO corpo com a MESMA chave; a repetição (200) é avisada', async () => {
    let vez = 0;
    const { pg } = await abrir({
      entregar: () => {
        vez += 1;
        return vez === 1 ? new Error('rede') : { status: 200, corpo: { status: 'ok', repetida: true, entrega: { id: 9001, ficha: { id: 77, numero: 12 } }, solicitacao: { id: 301, status: 'APROVADA_PARCIAL' } } };
      },
    });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.match(texto(pg, 'avisoEntrega'), /Não foi possível confirmar se a entrega foi registrada/);
    assert.equal(loteCampo(pg, 501).disabled, true, 'nada muda até resolver a tentativa');
    assert.equal(pg.el('aceitePresencial').disabled, true);
    assert.equal(pg.visivel('botaoTentarNovamente'), true);
    await pg.clicar('botaoTentarNovamente');
    await pg.esperar();
    const [a, b] = entregas(pg);
    assert.deepEqual(b.corpo, a.corpo, 'mesmo corpo e mesma chave');
    assert.match(texto(pg, 'avisoDetalhe'), /já havia sido registrada[\s\S]*ficha nº 12/);
  });

  test('tentativa incerta: só "Tentar novamente" ou "Descartar" saem dela; "Voltar à lista" fica desabilitado e outra linha da lista não troca o pedido', async () => {
    const { pg } = await abrir({ lista: [linha(), linha({ id: 302, numero: 42 })], entregar: () => new Error('rede') });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.equal(pg.el('botaoFecharDetalhe').disabled, true);
    await pg.consulta('#listaEntregas [data-solicitacao-id="302"]')[0].disparar('click');
    await pg.esperar();
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/302').length, 0);
    assert.match(texto(pg, 'detalheTitulo'), /Pedido nº 41/);
    assert.equal(pg.visivel('botaoTentarNovamente'), true);
  });

  test('descartar a tentativa incerta relê o pedido (a verdade do servidor) antes de qualquer nova entrega', async () => {
    const { pg } = await abrir({ entregar: () => new Error('rede') });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    await pg.clicar('botaoDescartarTentativa');
    await pg.esperar();
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/301').length, 2);
    assert.equal(pg.visivel('painelEntrega'), false);
  });

  for (const [codigo, esperado] of [
    ['QUANTIDADE_ACIMA_DA_COBERTURA', /estoque disponível para este pedido mudou/],
    ['QUANTIDADE_ACIMA_DO_PENDENTE', /quantidade pendente mudou/],
    ['SALDO_INSUFICIENTE', /saldo do lote mudou/],
  ]) {
    test(`concorrência: 409 ${codigo} → mensagem própria, o detalhe e os lotes são relidos e a confirmação é descartada`, async () => {
      const { pg } = await abrir({ entregar: () => ({ status: 409, corpo: { status: 'error', codigo, message: 'interno' } }) });
      await abrirDetalhe(pg);
      await prepararEntrega(pg);
      await aceitar(pg);
      await registrar(pg);
      assert.match(texto(pg, 'avisoEntrega'), esperado);
      assert.equal(/interno/.test(texto(pg, 'conteudoProtegido')), false);
      assert.equal(chamadas(pg, 'GET /solicitacoes-epi/301').length, 2);
      assert.equal(chamadas(pg, 'GET /entregas-epi/contexto/11/materiais/30/lotes').length, 2);
      assert.equal(pg.el('aceitePresencial').checked, false);
    });
  }

  test('409 SOLICITACAO_NAO_ENTREGAVEL (encerrada ou inativada por outra operação): aviso, detalhe e lista relidos', async () => {
    const { pg } = await abrir({ entregar: () => ({ status: 409, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_ENTREGAVEL', message: 'x' } }) });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.match(texto(pg, 'avisoDetalhe'), /não pode mais receber entrega/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 2);
  });

  test('400 do servidor no lote: o erro aparece no lote certo, com o texto da tela', async () => {
    const { pg } = await abrir({ entregar: () => ({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'body.itens[1].quantidade', codigo: 'QUANTIDADE_INVALIDA', mensagem: 'interno' }] } }) });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.match(erroDoLote(pg, 502), /inteira/);
    assert.equal(erroDoLote(pg, 501), '');
  });

  test('rascunho (sem DOM): lotes do item, sugestão FIFO, validação e corpo com assinatura desenhada', () => {
    const M = modulo();
    const R = M.rascunho;
    assert.equal(R.disponivelAgora(ITEM_BOTINA), 2);
    assert.equal(R.disponivelAgora(ITEM_CAPACETE), 0);
    assert.equal(R.disponivelAgora(ITEM_LUVA), 0);
    assert.equal(R.disponivelAgora({ ...ITEM_BOTINA, cobertura: { coberta: 5 } }), 2, 'nunca acima do pendente');
    assert.deepEqual(R.lotesDoItem(ITEM_BOTINA, LOTES_BOTINA).map((l) => l.loteId), [501, 502]);
    assert.deepEqual(R.lotesDoItem({ ...ITEM_BOTINA, tamanho: null }, [{ loteId: 1, tamanho: null, saldo: 2, situacaoCa: 'NAO_EXIGE_CA' }, { loteId: 2, tamanho: null, saldo: 2, situacaoCa: 'SEM_CA' }]).map((l) => l.loteId), [1]);
    assert.deepEqual(R.lotesDoItem(ITEM_BOTINA, [{ loteId: 7, tamanho: '40', saldo: 0, situacaoCa: 'VALIDO' }, ...LOTES_BOTINA]).map((l) => l.loteId), [501, 502], 'lote sem saldo não serve');
    assert.deepEqual(R.sugestaoFifo(ITEM_BOTINA, R.lotesDoItem(ITEM_BOTINA, LOTES_BOTINA)), { 501: '1', 502: '1' });
    assert.deepEqual(R.sugestaoFifo({ ...ITEM_BOTINA, cobertura: { coberta: 1 } }, R.lotesDoItem(ITEM_BOTINA, LOTES_BOTINA)), { 501: '1', 502: '0' }, 'a sugestão para no coberto, não no pendente');
    const v = R.validar([ITEM_BOTINA], { 11: { 501: '1', 502: '1' } }, { 11: R.lotesDoItem(ITEM_BOTINA, LOTES_BOTINA) });
    assert.deepEqual(v, { ok: true, itens: [{ solicitacaoItemId: 11, loteId: 501, quantidade: 1 }, { solicitacaoItemId: 11, loteId: 502, quantidade: 1 }] });
    const F = require('../js/epi-ficha'); // eslint-disable-line global-require
    assert.equal(R.corpo(v.itens, { modo: 'DESENHO', tracos: [] }), null, 'assinatura desenhada sem traços não vale');
    assert.deepEqual(R.corpo(v.itens, { modo: 'DESENHO', tracos: [[[1, 2], [3, 4]]] }).confirmacao, {
      modo: 'DESENHO', tracos: [[[1, 2], [3, 4]]], declaracaoVersao: F.DECLARACAO.versao, declaracaoTexto: F.DECLARACAO.texto,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('18–22. erros, isolamento e sessão', () => {
  test('isolamento: o pedido de outra empresa (ou inexistente) é "não encontrada"; o detalhe fecha e a lista é relida', async () => {
    const { pg } = await abrir({ lista: [linha(), linha({ id: 302, numero: 42 })] });
    await abrirDetalhe(pg, 302);
    assert.match(texto(pg, 'avisoLista'), /Solicitação não encontrada/);
    assert.equal(pg.visivel('detalheConteudo'), false);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 2);
    for (const c of pg.chamadas) assert.equal(/empresa|usuario/i.test(c.url + JSON.stringify(c.corpo)), false, c.url);
  });

  test('401 na entrega: Portal, e nada fica à mostra', async () => {
    const { pg } = await abrir({ entregar: () => ({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } }) });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('403 na entrega: mensagem funcional, sem o texto do servidor', async () => {
    const { pg } = await abrir({ entregar: () => ({ status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'regra interna X' } }) });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.match(texto(pg, 'avisoEntrega'), /autorização "Realizar entrega"/);
    assert.equal(/regra interna/.test(texto(pg, 'conteudoProtegido')), false);
  });

  test('409 IDEMPOTENCIA_CONFLITO: texto próprio', async () => {
    const { pg } = await abrir({ entregar: () => ({ status: 409, corpo: { status: 'error', codigo: 'IDEMPOTENCIA_CONFLITO', message: 'x' } }) });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    await aceitar(pg);
    await registrar(pg);
    assert.match(texto(pg, 'avisoEntrega'), /já foi usada com outro conteúdo/);
  });

  test('trabalhador inativo ao buscar os lotes: aviso, nada a entregar', async () => {
    const { pg, s } = await abrir();
    s.erroLotes = { status: 409, corpo: { status: 'error', codigo: 'FUNCIONARIO_INATIVO', message: 'x' } };
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    assert.match(texto(pg, 'avisoEntrega'), /trabalhador está inativo/);
    assert.equal(pg.el('botaoRegistrarEntrega').disabled, true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('23–24. encerramento', () => {
  test('encerrar: explica o que acontece, pede a justificativa e envia; a lista é relida e o detalhe fecha', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await pg.clicar('botaoEncerrar');
    assert.equal(pg.visivel('painelEncerramento'), true);
    assert.match(texto(pg, 'painelEncerramento'), /continua registrad[\s\S]*deixa de ser demanda/);
    assert.equal(pg.el('justificativaEncerramento').getAttribute('maxlength'), '500');
    await pg.digitar('justificativaEncerramento', '  Trabalhador desligado  ');
    await pg.clicar('botaoConfirmarEncerramento');
    await pg.esperar();
    const c = chamadas(pg, 'POST /solicitacoes-epi/301/encerramento');
    assert.deepEqual(c.map((x) => x.corpo), [{ justificativa: 'Trabalhador desligado' }]);
    assert.match(texto(pg, 'avisoLista'), /Pedido nº 41 encerrado/);
    assert.equal(pg.visivel('detalheConteudo'), false);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 2);
  });

  test('justificativa obrigatória (vazia ou só espaços) e até 500 caracteres; "Voltar" não envia nada', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await pg.clicar('botaoEncerrar');
    await pg.digitar('justificativaEncerramento', '   ');
    await pg.clicar('botaoConfirmarEncerramento');
    assert.match(texto(pg, 'justificativaEncerramento-erro'), /Informe a justificativa/);
    assert.equal(pg.el('justificativaEncerramento').getAttribute('aria-invalid'), 'true');
    await pg.digitar('justificativaEncerramento', 'x'.repeat(501));
    await pg.clicar('botaoConfirmarEncerramento');
    assert.match(texto(pg, 'justificativaEncerramento-erro'), /500/);
    await pg.clicar('botaoVoltarEncerramento');
    assert.equal(pg.visivel('painelEncerramento'), false);
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi/301/encerramento').length, 0);
  });

  test('encerramento: duplo clique é um POST; 409 SOLICITACAO_NAO_ENCERRAVEL avisa e relê', async () => {
    const { pg, s } = await abrir({ encerrar: () => ({ status: 409, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_ENCERRAVEL', message: 'x' } }) });
    await abrirDetalhe(pg);
    await pg.clicar('botaoEncerrar');
    await pg.digitar('justificativaEncerramento', 'Motivo');
    s.pendente.encerrar = true;
    pg.el('botaoConfirmarEncerramento').disparar('click');
    pg.el('botaoConfirmarEncerramento').disabled = false;
    pg.el('botaoConfirmarEncerramento').disparar('click');
    await pg.esperar();
    assert.equal(chamadas(pg, 'POST /solicitacoes-epi/301/encerramento').length, 1);
    s.pendente.encerrar();
    await pg.esperar();
    assert.match(texto(pg, 'avisoDetalhe'), /não pode ser encerrada/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/301').length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('25–28. permissões efetivas, perfil e volta pelo histórico', () => {
  test('só ENCERRAR_SOLICITACAO: a lista vem das encerráveis, sem entrega (nem lotes) e com o encerramento', async () => {
    const { pg } = await abrir({ p: permissoes({ acoes: { ENCERRAR_SOLICITACAO: true } }) });
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 0);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/encerraveis').length, 1);
    await abrirDetalhe(pg);
    assert.equal(pg.visivel('botaoPrepararEntrega'), false);
    assert.equal(pg.visivel('botaoEncerrar'), true);
    assert.equal(pg.chamadas.filter((c) => /lotes/.test(c.chave)).length, 0);
  });

  test('só REALIZAR_ENTREGA: entrega sem o encerramento (nem o selo "Encerrável")', async () => {
    const { pg } = await abrir({ p: permissoes({ acoes: { REALIZAR_ENTREGA: true } }) });
    assert.equal(/Encerrável/.test(linhas(pg)[0].textContent), false);
    await abrirDetalhe(pg);
    assert.equal(pg.visivel('botaoPrepararEntrega'), true);
    assert.equal(pg.visivel('botaoEncerrar'), false);
  });

  test('sem as ações (MASTER, ADMINISTRADOR ou SUPERVISOR sem concessão efetiva): acesso negado, nenhuma lista consultada; MASTER com a ação trabalha normalmente', async () => {
    for (const perfil of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR']) {
      const { pg } = await abrir({ p: permissoes({ perfil, acoes: {} }) });
      assert.equal(pg.visivel('conteudoProtegido'), false, perfil);
      assert.equal(chamadas(pg, 'GET /solicitacoes-epi/entregaveis').length, 0, perfil);
    }
    const { pg } = await abrir({ p: permissoes({ perfil: 'MASTER', acoes: { REALIZAR_ENTREGA: true } }) });
    assert.equal(linhas(pg).length, 1);
  });

  test('volta pelo histórico com permissões alteradas: detalhe, lotes e lista somem antes de recarregar', async () => {
    const { pg, s } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    s.p = permissoes({ acoes: {} });
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.deepEqual(pg.navegacoes, ['/pages/stock-requests.html']);
    for (const t of ['Ana Sintética', 'Botina de segurança', '12345']) assert.equal(pg.textoDoDom().includes(t), false, t);
  });

  test('volta pelo histórico com a resposta pendente: conteúdo fechado até a revalidação liberar', async () => {
    const { pg, s } = await abrir();
    await abrirDetalhe(pg);
    s.pendente.permissoes = true;
    const volta = pg.eventoDaJanela('pageshow', { persisted: true });
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    s.pendente.permissoes();
    await volta;
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('29. semântica, acessibilidade, segurança e visual', () => {
  test('campos de quantidade com rótulo; erros ligados por aria-describedby; justificativa do encerramento com rótulo', async () => {
    const { pg } = await abrir();
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    for (const c of pg.consulta('#entregaItens input')) {
      const id = c.getAttribute('id');
      assert.ok(id && pg.consulta(`label[for="${id}"]`).length === 1, `rótulo de ${id}`);
      assert.ok(pg.documento.getElementById(c.getAttribute('aria-describedby').split(' ').pop()), `erro ligado a ${id}`);
    }
    assert.equal(pg.consulta('label[for="justificativaEncerramento"]').length, 1);
  });

  test('HTML vindo do servidor é sempre texto; nada passa por innerHTML; nada no armazenamento', async () => {
    const ATAQUE = '<img src=x onerror=alert(1)>';
    const { pg } = await abrir({
      lista: [linha({ funcionario: { id: 11, nome: ATAQUE, matricula: ATAQUE, ativo: true } })],
      detalhe: detalheDe({ itens: [{ ...ITEM_BOTINA, material: { nome: ATAQUE, unidade: ATAQUE } }] }),
      lotes: [{ ...LOTES_BOTINA[0], caNumero: ATAQUE }],
    });
    await abrirDetalhe(pg);
    await prepararEntrega(pg);
    assert.equal(pg.consulta('img').length, 0);
    assert.ok(pg.textoDoDom().includes(ATAQUE));
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.deepEqual(pg.storage.filter((x) => !(x.operacao === 'removeItem' || x.storage === 'cookie')), []);
  });

  test('nada de "Em integração" na área funcional; o alerta (12G-6) continua desabilitado; a regra futura segue preservada em comentário', () => {
    const bruto = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');
    assert.match(bruto, /<!--[\s\S]*Quando um funcionário solicitar um material sem estoque/);
    const html = bruto.replace(/<!--[\s\S]*?-->/g, '').replace(/<nav class="nav">[\s\S]*?<\/nav>/, '');
    const protegido = html.slice(html.indexOf('id="conteudoProtegido"'));
    assert.equal(/Em integração|data-area-integracao|data-estado-area/.test(protegido), false);
    assert.match(html, /class="filled-btn botao-em-integracao"[^>]*disabled[^>]*>[\s\S]*?Gerar alerta/);
  });

  for (const tema of ['light', 'dark']) {
    test(`botão desabilitado parece desabilitado (tema ${tema}): "Preparar entrega" sem nada disponível agora e "Anterior" em cinza, sem o azul de ação, com cursor de bloqueio`, async () => {
      const soAguardando = detalheDe({ itens: [ITEM_CAPACETE], situacao: 'PARCIALMENTE_ENTREGUE' });
      const { pg } = await abrir({ detalhe: soAguardando, totalLista: 25 });
      await abrirDetalhe(pg);
      pg.documento.documentElement.setAttribute('data-theme', tema);
      const tk = (nome) => token(pg, PAGINA, nome);
      const azul = tk('--primary').toLowerCase();
      for (const id of ['botaoPrepararEntrega', 'listaAnterior']) {
        assert.equal(pg.el(id).disabled, true, id);
        for (const hover of [false, true]) {
          const e = estiloComputado(pg, PAGINA, pg.el(id), ['opacity', 'cursor', 'color', 'background', 'border'], { hover });
          const onde = `${id} ${tema}${hover ? ' (mouse em cima)' : ''}: ${JSON.stringify(e)}`;
          assert.ok(Number(e.opacity) <= 0.6, onde);
          assert.equal(e.cursor, 'not-allowed', onde);
          assert.deepEqual([e.color, e.background], [tk('--on-surface-variant'), tk('--surface-container-high')], onde);
          for (const p of ['color', 'background', 'border']) assert.equal(String(e[p]).toLowerCase().includes(azul), false, `${onde} — ${p}`);
        }
      }
      assert.match(texto(pg, 'detalheAcoes'), /Nada disponível agora/);
    });
  }
});
