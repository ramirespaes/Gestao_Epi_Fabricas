'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const { estiloComputado, token } = require('./helpers/estilo-computado');

/**
 * 12G-3 — Aprovação da Segurança do Trabalho (pages/supervisor-approval.html +
 * js/aprovacao-sst.js) sobre os contratos da 12F: a fila PENDENTE, o detalhe
 * e a decisão de todos os itens num POST só. A autorização é a efetiva do
 * servidor (APROVAR_SOLICITACAO e REPROVAR_SOLICITACAO), nunca o perfil; quem
 * criou o pedido não decide (AUTODECISAO_PROIBIDA); aprovar não depende de
 * estoque, e nenhum número de estoque aparece.
 */

const RAIZ = path.join(__dirname, '..');
const PAGINA = 'pages/supervisor-approval.html';
const { JUSTIFICATIVA_MAXIMA, DECISOES } = require('../../backend/src/repositories/solicitacao-epi-item.repository');

function modulo() {
  assert.ok(fs.existsSync(path.join(RAIZ, 'js/aprovacao-sst.js')), 'comportamento ausente: js/aprovacao-sst.js (a tela da Aprovação da Segurança do Trabalho) não existe');
  require('../js/solicitacoes-epi'); // eslint-disable-line global-require
  return require('../js/aprovacao-sst'); // eslint-disable-line global-require
}

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const AMBAS = { APROVAR_SOLICITACAO: true, REPROVAR_SOLICITACAO: true };
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
  id: 201, numero: 31, status: 'PENDENTE', situacaoOperacional: null, solicitanteUsuarioId: 9,
  funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', ativo: true }, quantidadeItens: 2,
  quantidades: { solicitada: 5, aprovada: null, entregue: null, restante: null }, criadaEm: '2026-10-03T13:05:00.000Z', decididaEm: null, canceladaEm: null, entregueEm: null,
  ...extra,
});
const ITEM_BOTINA = {
  id: 1, materialId: 30, tamanho: '40', quantidade: 2, motivo: 'DESGASTE_DANO', justificativa: null, previstoNoGhe: true,
  decisao: null, quantidadeAprovada: null, justificativaDecisao: null, quantidadeEntregue: 0, quantidadePendente: null, situacao: 'AGUARDANDO_ESTOQUE',
  material: { nome: 'Botina de segurança', unidade: 'par' }, cobertura: { coberta: 0, semCobertura: 2 }, posicao: { fisicoUtilizavel: 77, saldoLivre: 66 },
};
const ITEM_CAPACETE = {
  id: 2, materialId: 31, tamanho: null, quantidade: 3, motivo: 'OUTRO', justificativa: 'Capacete trincado na queda', previstoNoGhe: false,
  decisao: null, quantidadeAprovada: null, justificativaDecisao: null, quantidadeEntregue: 0, quantidadePendente: null, situacao: 'AGUARDANDO_ESTOQUE',
  material: { nome: 'Capacete de segurança', unidade: 'unidade' }, cobertura: { coberta: 0, semCobertura: 3 }, posicao: { fisicoUtilizavel: 0, saldoLivre: 0 },
};
function detalheDe({
  id = 201, numero = 31, status = 'PENDENTE', solicitante = { id: 9, nome: 'Luis Solicitante' }, origem = 'USUARIO_INTERNO', itens = [ITEM_BOTINA, ITEM_CAPACETE], observacao = 'Troca antes da parada.',
} = {}) {
  return {
    status: 'ok',
    solicitacao: {
      id, numero, status, origemSolicitacao: origem, solicitanteUsuarioId: solicitante.id, funcionarioId: 11, gheId: 2, quantidadeItens: itens.length,
      observacao, criadaEm: '2026-10-03T13:05:00.000Z', decisao: null, cancelamento: null, entregueEm: null, encerramento: null, situacaoOperacional: 'AGUARDANDO_ESTOQUE',
      quantidades: { solicitada: 5, aprovada: null, entregue: null, restante: null },
      funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', setor: 'Fundição', funcao: 'Operadora de forno', ativo: true, cpf: '52998224725' },
      solicitante: { ...solicitante, email: 'luis@example.invalid' },
    },
    itens,
  };
}

/** "Servidor" com estado: o teste troca respostas e segura as que quiser pendentes. */
function servidor({
  p = permissoes(), fila = [linha()], totalFila = null, detalhes = { 201: detalheDe() }, decidir = null,
} = {}) {
  const s = {
    p, fila, totalFila, detalhes, decidir, pendente: {},
  };
  const corpo = (status, c) => ({ status, corpo: c });
  const segurar = (nome, resposta) => (s.pendente[nome] ? new Promise((r) => { s.pendente[nome] = () => { s.pendente[nome] = false; r(resposta()); }; }) : resposta());
  const rotas = {
    'GET /auth/me': () => corpo(200, { status: 'ok', usuario: { id: 7, nome: 'Sara da Segurança', email: 'sara@example.invalid', perfil: s.p.perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }),
    'GET /auth/global/me': () => corpo(200, { status: 'ok', empresas: [{ id: 3 }] }),
    'GET /auth/permissoes': () => segurar('permissoes', () => corpo(200, s.p)),
    'GET /solicitacoes-epi/fila': (c) => segurar('fila', () => {
      if (s.erroFila) return corpo(s.erroFila, { status: 'error', codigo: 'X', message: 'falha interna em SQL' });
      const u = new URL(c.url).searchParams;
      return corpo(200, {
        status: 'ok', solicitacoes: s.fila, total: s.totalFila ?? s.fila.length, pagina: Number(u.get('pagina')), limite: Number(u.get('limite')),
      });
    }),
  };
  for (const id of [201, 202, 203]) {
    rotas[`GET /solicitacoes-epi/${id}`] = () => segurar('detalhe', () => {
      const d = s.detalhes[id];
      if (d === undefined) return corpo(404, { status: 'error', codigo: 'SOLICITACAO_NAO_ENCONTRADA', message: 'Solicitação não encontrada' });
      if (typeof d === 'function') return d();
      return d.status === 'ok' ? corpo(200, d) : d;
    });
    rotas[`POST /solicitacoes-epi/${id}/decisao`] = (c) => segurar('decidir', () => (s.decidir ? s.decidir(c)
      : corpo(200, { status: 'ok', solicitacao: { id, numero: 31, status: 'APROVADA' }, itens: [] })));
  }
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
const linhasDaFila = (pg) => pg.consulta('#listaFila [data-solicitacao-id]');
async function analisar(pg, id = 201) {
  const botao = pg.consulta(`#listaFila [data-solicitacao-id="${id}"]`)[0];
  assert.ok(botao, `pedido ${id} na fila`);
  await botao.disparar('click');
  await pg.esperar();
}
const cartao = (pg, itemId) => pg.consulta(`#analiseItens [data-item-id="${itemId}"]`)[0];
const campo = (pg, itemId, nome) => cartao(pg, itemId).querySelector(`[data-campo="${nome}"]`);
const erro = (pg, itemId, nome) => { const e = cartao(pg, itemId).querySelector(`[data-erro="${nome}"]`); return e ? e.textContent : ''; };
async function decidir(pg, itemId, decisao) {
  const radio = cartao(pg, itemId).querySelector(`input[type="radio"][value="${decisao}"]`);
  assert.ok(radio, `opção ${decisao} do item ${itemId}`);
  radio.checked = true;
  await radio.disparar('change');
  await pg.esperar();
}
async function digitar(pg, itemId, nome, valor) {
  const c = campo(pg, itemId, nome);
  assert.ok(c, `campo ${nome} do item ${itemId}`);
  c.value = String(valor);
  await c.disparar('input');
  await pg.esperar();
}
const concluir = async (pg) => { await pg.clicar('botaoConcluirAnalise'); await pg.esperar(); };
const posts = (pg, id = 201) => chamadas(pg, `POST /solicitacoes-epi/${id}/decisao`);
const SO_GHE = detalheDe({ itens: [ITEM_BOTINA, { ...ITEM_CAPACETE, previstoNoGhe: true }] });

// ─────────────────────────────────────────────────────────────────────
describe('contrato: decisões e limite da justificativa são os do backend', () => {
  test('APROVADO e REPROVADO; justificativa até o limite do backend', () => {
    const A = modulo();
    assert.deepEqual([...A.DECISOES], [...DECISOES]);
    assert.equal(A.JUSTIFICATIVA_MAXIMA, JUSTIFICATIVA_MAXIMA);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('1–2. fila', () => {
  test('carrega a fila PENDENTE do servidor (sem empresa ou usuário na consulta) e mostra número, data, trabalhador, matrícula, itens e situação; nunca CPF', async () => {
    const { pg } = await abrir();
    const fila = chamadas(pg, 'GET /solicitacoes-epi/fila');
    assert.equal(fila.length, 1);
    assert.equal(new URL(fila[0].url).search, '?pagina=1&limite=20');
    const linhas = linhasDaFila(pg);
    assert.equal(linhas.length, 1);
    const t = linhas[0].textContent;
    for (const esperado of [/Pedido nº 31/, /03\/10\/2026/, /Ana Sintética/, /M-011/, /2 itens/, /5 unidades/, /Pendente/]) assert.match(t, esperado);
    assert.equal(/52998224725|CPF/i.test(pg.textoDoDom()), false);
    assert.equal(/Em integração/.test(texto(pg, 'conteudoProtegido')), false, 'nada de "Em integração" na tela funcional');
  });

  test('fila vazia: estado vazio claro; a análise espera uma escolha', async () => {
    const { pg } = await abrir({ fila: [] });
    assert.equal(pg.consulta('#listaFila [data-estado="vazio"]').length, 1);
    assert.match(texto(pg, 'listaFila'), /Não há solicitações aguardando análise\./);
    assert.equal(pg.visivel('analiseConteudo'), false);
  });

  test('erro ao carregar a fila: estado de erro sem texto técnico; "Atualizar" consulta de novo', async () => {
    const { pg, s } = await abrir({});
    s.erroFila = 500;
    await pg.clicar('botaoAtualizarFila');
    assert.equal(pg.consulta('#listaFila [data-estado="erro"]').length, 1);
    assert.equal(/SQL/.test(texto(pg, 'listaFila')), false);
    s.erroFila = null;
    await pg.clicar('botaoAtualizarFila');
    assert.equal(linhasDaFila(pg).length, 1);
  });

  test('paginação da fila: "Página 1 de 2", a próxima pede a página 2; na primeira, "Anterior" desabilitado', async () => {
    const { pg } = await abrir({ totalFila: 25 });
    assert.match(texto(pg, 'filaPaginacaoTexto'), /Página 1 de 2/);
    assert.equal(pg.el('filaAnterior').disabled, true);
    await pg.clicar('filaProxima');
    assert.equal(new URL(chamadas(pg, 'GET /solicitacoes-epi/fila').at(-1).url).searchParams.get('pagina'), '2');
  });

  test('o pedido criado pela própria pessoa aparece marcado na fila', async () => {
    const { pg } = await abrir({ fila: [linha({ solicitanteUsuarioId: 7 })] });
    assert.match(linhasDaFila(pg)[0].textContent, /Criado por você/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('3–8. análise: dados do pedido e dos itens', () => {
  test('abre pelo pedido: trabalhador, matrícula, setor, função, solicitante, data, observação e itens; sem CPF, e-mail ou números de estoque', async () => {
    const { pg } = await abrir();
    await analisar(pg);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/201').length, 1);
    assert.equal(pg.visivel('analiseConteudo'), true);
    assert.match(texto(pg, 'analiseTitulo'), /Pedido nº 31/);
    const resumo = texto(pg, 'analiseResumo');
    for (const esperado of [/Ana Sintética/, /M-011/, /Fundição/, /Operadora de forno/, /Luis Solicitante/, /03\/10\/2026/, /Troca antes da parada\./, /Pendente/]) assert.match(resumo, esperado);
    const t = texto(pg, 'conteudoProtegido');
    assert.equal(/52998224725|example\.invalid|@|\b77\b|\b66\b|saldo|estoque|cobertura|lote/i.test(t), false, t);
    assert.equal(pg.foco(), 'analiseTitulo');
  });

  test('cada item: EPI, quantidade solicitada com a unidade, motivo e a justificativa do pedido', async () => {
    const { pg } = await abrir();
    await analisar(pg);
    const botina = cartao(pg, 1).textContent;
    assert.match(botina, /Botina de segurança/);
    assert.match(botina, /2 par/);
    assert.match(botina, /Desgaste ou dano/);
    const capacete = cartao(pg, 2).textContent;
    assert.match(capacete, /Capacete de segurança/);
    assert.match(capacete, /3 unidade/);
    assert.match(capacete, /Outro/);
    assert.match(capacete, /Capacete trincado na queda/);
  });

  test('item com tamanho mostra o tamanho; item sem tamanho diz claramente que não usa', async () => {
    const { pg } = await abrir();
    await analisar(pg);
    assert.match(cartao(pg, 1).textContent, /Tamanho: 40/);
    assert.match(cartao(pg, 2).textContent, /Não usa tamanho/);
  });

  test('previsto no GHE e fora do GHE com selos distintos', async () => {
    const { pg } = await abrir();
    await analisar(pg);
    const selo = (itemId) => cartao(pg, itemId).querySelector('[data-ghe]');
    assert.deepEqual([selo(1).getAttribute('data-ghe'), selo(1).textContent], ['previsto', 'Previsto no GHE']);
    assert.deepEqual([selo(2).getAttribute('data-ghe'), selo(2).textContent], ['fora', 'Fora do GHE do trabalhador']);
  });

  test('pedido que já foi decidido por outra operação ao abrir: aviso, nenhuma decisão possível e a fila atualizada', async () => {
    const { pg } = await abrir({ detalhes: { 201: detalheDe({ status: 'APROVADA' }) } });
    await analisar(pg);
    assert.match(texto(pg, 'avisoAnalise'), /já foi analisada ou cancelada/);
    assert.equal(pg.consulta('#analiseItens input[type="radio"]').filter((r) => !r.disabled).length, 0);
    assert.equal(pg.el('botaoConcluirAnalise').disabled, true);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/fila').length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('9–17. decisão de cada item', () => {
  test('aprovar integralmente: a quantidade aprovada começa na solicitada; um POST com todos os itens; resultado "Aprovada"; fila atualizada sem F5', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    assert.equal(campo(pg, 1, 'quantidade').value, '2');
    assert.equal(campo(pg, 1, 'justificativa'), null, 'aprovação integral no GHE não pede justificativa');
    await decidir(pg, 2, 'APROVADO');
    assert.match(texto(pg, 'resultadoPrevisto'), /Aprovada$|Aprovada\b(?! parcial)/);
    await concluir(pg);
    assert.equal(posts(pg).length, 1);
    assert.deepEqual(posts(pg)[0].corpo, {
      decisoes: [
        { itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 2, justificativa: null },
        { itemId: 2, decisao: 'APROVADO', quantidadeAprovada: 3, justificativa: null },
      ],
    });
    assert.match(texto(pg, 'avisoFila'), /Pedido nº 31 analisado: Aprovada\./);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/fila').length, 2, 'a fila foi relida');
    assert.equal(pg.visivel('analiseConteudo'), false, 'a análise fecha');
    assert.deepEqual(pg.navegacoes, []);
  });

  test('reduzir a quantidade: a justificativa da redução aparece e é obrigatória; o resultado previsto vira "Aprovada parcialmente"', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await decidir(pg, 2, 'APROVADO');
    await digitar(pg, 1, 'quantidade', '1');
    const j = campo(pg, 1, 'justificativa');
    assert.ok(j, 'campo da justificativa');
    assert.match(cartao(pg, 1).querySelector(`label[for="${j.getAttribute('id')}"]`).textContent, /redução/i);
    assert.match(texto(pg, 'resultadoPrevisto'), /Aprovada parcialmente/);
    await concluir(pg);
    assert.equal(posts(pg).length, 0);
    assert.match(erro(pg, 1, 'justificativa'), /redução/i);
    assert.equal(campo(pg, 1, 'justificativa').getAttribute('aria-invalid'), 'true', 'o campo (redesenhado) fica marcado');
    await digitar(pg, 1, 'justificativa', '  Troca de um pé só  ');
    await concluir(pg);
    assert.deepEqual(posts(pg)[0].corpo.decisoes[0], { itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 1, justificativa: 'Troca de um pé só' });
  });

  test('voltar à quantidade solicitada esconde a justificativa e não a envia', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await decidir(pg, 2, 'APROVADO');
    await digitar(pg, 1, 'quantidade', '1');
    await digitar(pg, 1, 'justificativa', 'motivo');
    await digitar(pg, 1, 'quantidade', '2');
    assert.equal(campo(pg, 1, 'justificativa'), null);
    await concluir(pg);
    assert.equal(posts(pg)[0].corpo.decisoes[0].justificativa, null);
  });

  test('reprovar: some a quantidade, a justificativa da reprovação é obrigatória; o corpo leva a decisão e a justificativa', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'REPROVADO');
    await decidir(pg, 2, 'REPROVADO');
    assert.equal(campo(pg, 1, 'quantidade'), null);
    assert.match(cartao(pg, 1).querySelector(`label[for="${campo(pg, 1, 'justificativa').getAttribute('id')}"]`).textContent, /reprovação/i);
    assert.match(texto(pg, 'resultadoPrevisto'), /Reprovada/);
    await concluir(pg);
    assert.equal(posts(pg).length, 0);
    assert.match(erro(pg, 1, 'justificativa'), /reprovação/i);
    assert.match(erro(pg, 2, 'justificativa'), /reprovação/i);
    await digitar(pg, 1, 'justificativa', 'Troca recente');
    await digitar(pg, 2, 'justificativa', 'Fora da política');
    await concluir(pg);
    assert.deepEqual(posts(pg)[0].corpo.decisoes, [
      { itemId: 1, decisao: 'REPROVADO', justificativa: 'Troca recente' },
      { itemId: 2, decisao: 'REPROVADO', justificativa: 'Fora da política' },
    ]);
  });

  test('aprovar EPI fora do GHE exige a justificativa (mesmo na quantidade integral)', async () => {
    const { pg } = await abrir();
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await decidir(pg, 2, 'APROVADO');
    const j = campo(pg, 2, 'justificativa');
    assert.ok(j);
    assert.match(cartao(pg, 2).querySelector(`label[for="${j.getAttribute('id')}"]`).textContent, /fora do GHE/i);
    await concluir(pg);
    assert.equal(posts(pg).length, 0);
    assert.match(erro(pg, 2, 'justificativa'), /não estava previsto no GHE/);
    await digitar(pg, 2, 'justificativa', 'Exposição pontual a queda de material');
    await concluir(pg);
    assert.deepEqual(posts(pg)[0].corpo.decisoes[1], { itemId: 2, decisao: 'APROVADO', quantidadeAprovada: 3, justificativa: 'Exposição pontual a queda de material' });
  });

  test('decisão mista (um aprovado, um reprovado): resultado "Aprovada parcialmente" e o corpo com as duas decisões', async () => {
    const { pg } = await abrir();
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await decidir(pg, 2, 'REPROVADO');
    await digitar(pg, 2, 'justificativa', 'Não previsto e sem exposição');
    assert.match(texto(pg, 'resultadoPrevisto'), /Aprovada parcialmente/);
    await concluir(pg);
    assert.deepEqual(posts(pg)[0].corpo.decisoes, [
      { itemId: 1, decisao: 'APROVADO', quantidadeAprovada: 2, justificativa: null },
      { itemId: 2, decisao: 'REPROVADO', justificativa: 'Não previsto e sem exposição' },
    ]);
  });

  test('quantidade maior que a solicitada, zero, decimal ou vazia: erro no campo e nada enviado; o campo vai de 1 até a solicitada', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await decidir(pg, 2, 'APROVADO');
    assert.deepEqual([campo(pg, 1, 'quantidade').getAttribute('min'), campo(pg, 1, 'quantidade').getAttribute('max')], ['1', '2']);
    await digitar(pg, 1, 'quantidade', '5');
    await concluir(pg);
    assert.match(erro(pg, 1, 'quantidade'), /não pode passar da solicitada \(2\)/);
    for (const q of ['0', '1.5', '']) {
      await digitar(pg, 1, 'quantidade', q);
      await concluir(pg);
      assert.match(erro(pg, 1, 'quantidade'), /inteira a partir de 1/, q);
    }
    assert.equal(posts(pg).length, 0);
  });

  test('a decisão cobre todos os itens: item sem decisão é apontado e nada é enviado', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await concluir(pg);
    assert.equal(posts(pg).length, 0);
    assert.match(erro(pg, 2, 'decisao'), /Escolha aprovar ou reprovar/);
    assert.equal(erro(pg, 1, 'decisao'), '');
    assert.match(texto(pg, 'avisoAnalise'), /Revise/);
    assert.match(texto(pg, 'resultadoPrevisto'), /Decida todos os itens/);
  });

  test('rascunho (sem DOM): sem a autorização da ação, nem aprovar nem reprovar vira corpo de envio (além do botão indisponível)', () => {
    const A = modulo();
    const itens = [{ ...ITEM_BOTINA, previstoNoGhe: true }];
    const aprovado = { 1: { decisao: 'APROVADO', quantidade: '2', justificativa: '' } };
    const reprovado = { 1: { decisao: 'REPROVADO', quantidade: '2', justificativa: 'x' } };
    assert.equal(A.rascunho.validar(itens, aprovado, { aprovar: true, reprovar: false }).ok, true);
    assert.deepEqual(A.rascunho.validar(itens, aprovado, { aprovar: false, reprovar: true }).erros.map((e) => [e.campo, e.mensagem]), [['decisao', 'Você não tem a autorização "Aprovar solicitação".']]);
    assert.equal(A.rascunho.validar(itens, reprovado, { aprovar: false, reprovar: true }).ok, true);
    assert.deepEqual(A.rascunho.validar(itens, reprovado, { aprovar: true, reprovar: false }).erros.map((e) => [e.campo, e.mensagem]), [['decisao', 'Você não tem a autorização "Reprovar solicitação".']]);
  });

  test('rascunho (sem DOM): justificativa só quando o servidor a exige, na ordem dele; resultado como o do servidor', () => {
    const A = modulo();
    const motivos = (item, d) => A.rascunho.motivosDaJustificativa(item, d);
    assert.deepEqual(motivos(ITEM_BOTINA, { decisao: 'APROVADO', quantidade: '2' }), []);
    assert.deepEqual(motivos(ITEM_BOTINA, { decisao: 'APROVADO', quantidade: '1' }), ['reduzido']);
    assert.deepEqual(motivos(ITEM_CAPACETE, { decisao: 'APROVADO', quantidade: '3' }), ['foraDoGhe']);
    assert.deepEqual(motivos(ITEM_CAPACETE, { decisao: 'APROVADO', quantidade: '2' }), ['reduzido', 'foraDoGhe']);
    assert.deepEqual(motivos(ITEM_CAPACETE, { decisao: 'REPROVADO', quantidade: '3' }), ['reprovado']);
    const r = (decisoes) => A.rascunho.resultadoPrevisto([ITEM_BOTINA, ITEM_CAPACETE], decisoes);
    assert.equal(r({ 1: { decisao: 'APROVADO', quantidade: '2' }, 2: { decisao: 'APROVADO', quantidade: '3' } }), 'APROVADA');
    assert.equal(r({ 1: { decisao: 'APROVADO', quantidade: '1' }, 2: { decisao: 'APROVADO', quantidade: '3' } }), 'APROVADA_PARCIAL');
    assert.equal(r({ 1: { decisao: 'REPROVADO', quantidade: '2' }, 2: { decisao: 'APROVADO', quantidade: '3' } }), 'APROVADA_PARCIAL');
    assert.equal(r({ 1: { decisao: 'REPROVADO', quantidade: '2' }, 2: { decisao: 'REPROVADO', quantidade: '3' } }), 'REPROVADA');
    assert.equal(r({ 1: { decisao: 'APROVADO', quantidade: '2' }, 2: { decisao: null, quantidade: '3' } }), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('18–23. envio, segregação de funções, concorrência e isolamento', () => {
  async function prontoParaEnviar(opcoes) {
    const r = await abrir({ detalhes: { 201: SO_GHE }, ...opcoes });
    await analisar(r.pg);
    await decidir(r.pg, 1, 'APROVADO');
    await decidir(r.pg, 2, 'APROVADO');
    return r;
  }

  test('clique duplo, e até o botão reabilitado por outra renderização: um só POST; botão ocupado enquanto o servidor responde', async () => {
    const { pg, s } = await prontoParaEnviar();
    s.pendente.decidir = true;
    pg.el('botaoConcluirAnalise').disparar('click');
    pg.el('botaoConcluirAnalise').disparar('click');
    await pg.esperar();
    assert.equal(pg.el('botaoConcluirAnalise').disabled, true);
    assert.equal(pg.el('botaoConcluirAnalise').getAttribute('aria-busy'), 'true');
    pg.el('botaoConcluirAnalise').disabled = false;
    pg.el('botaoConcluirAnalise').disparar('click');
    await pg.esperar();
    assert.equal(posts(pg).length, 1);
    s.pendente.decidir();
    await pg.esperar();
    assert.equal(posts(pg).length, 1);
  });

  test('401 na decisão: Portal, e nada da análise fica à mostra', async () => {
    const { pg } = await prontoParaEnviar({ decidir: () => ({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } }) });
    await concluir(pg);
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('401 ao carregar a fila: Portal', async () => {
    const { s, rotas } = servidor();
    rotas['GET /solicitacoes-epi/fila'] = () => ({ status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } });
    modulo();
    const pg = abrirPagina(PAGINA, { rotas });
    await pg.esperar();
    void s;
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('403 sem autorização para a decisão: mensagem funcional, sem detalhe técnico; a análise continua aberta', async () => {
    const { pg } = await prontoParaEnviar({ decidir: () => ({ status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'Ação AUTORIZAR negada por regra interna' } }) });
    await concluir(pg);
    assert.match(texto(pg, 'avisoAnalise'), /autorização necessária para esta decisão/);
    assert.equal(/regra interna|AUTORIZAR/.test(texto(pg, 'avisoAnalise')), false);
    assert.equal(pg.visivel('analiseConteudo'), true);
  });

  test('AUTODECISAO_PROIBIDA vinda do servidor: aviso de separação de funções, sem texto técnico, e a decisão fica bloqueada', async () => {
    const { pg } = await prontoParaEnviar({ decidir: () => ({ status: 403, corpo: { status: 'error', codigo: 'AUTODECISAO_PROIBIDA', message: 'Quem criou a solicitação não pode aprová-la nem reprová-la' } }) });
    await concluir(pg);
    assert.match(texto(pg, 'avisoAnalise'), /Você criou esta solicitação/);
    assert.match(texto(pg, 'avisoAnalise'), /outra pessoa da Segurança do Trabalho/);
    assert.equal(pg.el('botaoConcluirAnalise').disabled, true);
    assert.equal(pg.consulta('#analiseItens input, #analiseItens textarea').filter((c) => !c.disabled).length, 0);
    await concluir(pg);
    assert.equal(posts(pg).length, 1);
  });

  test('o próprio pedido (criado pela pessoa, origem interna) é avisado antes: nenhuma decisão possível, nenhum POST', async () => {
    const proprio = detalheDe({ solicitante: { id: 7, nome: 'Sara da Segurança' } });
    const { pg } = await abrir({ fila: [linha({ solicitanteUsuarioId: 7 })], detalhes: { 201: proprio } });
    await analisar(pg);
    assert.match(texto(pg, 'avisoAnalise'), /Você criou esta solicitação/);
    assert.equal(pg.consulta('#analiseItens input[type="radio"]').filter((r) => !r.disabled).length, 0);
    assert.equal(pg.el('botaoConcluirAnalise').disabled, true);
    await concluir(pg);
    assert.equal(posts(pg).length, 0);
  });

  test('a regra é a do servidor: autoatendimento com o mesmo usuário não é bloqueado pela tela', () => {
    const A = modulo();
    assert.equal(A.rascunho.criadaPor({ origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 7 }, 7), true);
    assert.equal(A.rascunho.criadaPor({ origemSolicitacao: 'USUARIO_INTERNO', solicitanteUsuarioId: 9 }, 7), false);
    assert.equal(A.rascunho.criadaPor({ origemSolicitacao: 'AUTOATENDIMENTO', solicitanteUsuarioId: 7 }, 7), false);
  });

  for (const codigo of ['SOLICITACAO_NAO_PENDENTE', 'SOLICITACAO_ALTERADA']) {
    test(`409 ${codigo} (outra operação chegou antes): aviso, a análise fecha e a fila é relida`, async () => {
      const { pg } = await prontoParaEnviar({ decidir: () => ({ status: 409, corpo: { status: 'error', codigo, message: 'x' } }) });
      await concluir(pg);
      assert.match(texto(pg, 'avisoFila'), /outra operação/);
      assert.match(texto(pg, 'avisoFila'), /fila foi atualizada/);
      assert.equal(pg.visivel('analiseConteudo'), false);
      assert.equal(chamadas(pg, 'GET /solicitacoes-epi/fila').length, 2);
    });
  }

  test('400 do servidor com o campo do item: o erro aparece no item certo, com o texto da tela', async () => {
    const { pg } = await prontoParaEnviar({
      decidir: () => ({ status: 400, corpo: { status: 'error', codigo: 'VALIDACAO', message: 'x', detalhes: [{ campo: 'body.decisoes[1].justificativa', codigo: 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA', mensagem: 'interno' }] } }),
    });
    await concluir(pg);
    assert.match(erro(pg, 2, 'justificativa'), /não estava previsto no GHE/);
    assert.equal(erro(pg, 1, 'justificativa'), '');
    assert.equal(/interno/.test(texto(pg, 'conteudoProtegido')), false);
  });

  test('409 de trabalhador ou EPI inativo: mensagem própria e a análise continua (reprovar ainda é possível)', async () => {
    for (const [codigo, esperado] of [['FUNCIONARIO_INATIVO', /trabalhador está inativo/], ['MATERIAL_INATIVO', /desativado/]]) {
      const { pg } = await prontoParaEnviar({ decidir: () => ({ status: 409, corpo: { status: 'error', codigo, message: 'x' } }) });
      await concluir(pg);
      assert.match(texto(pg, 'avisoAnalise'), esperado, codigo);
      assert.equal(pg.visivel('analiseConteudo'), true, codigo);
      assert.equal(pg.el('botaoConcluirAnalise').disabled, false, codigo);
    }
  });

  test('falha de rede na decisão: aviso de resultado incerto e a fila relida (uma segunda decisão daria 409, nunca duplicaria)', async () => {
    const { pg } = await prontoParaEnviar({ decidir: () => new Error('rede') });
    await concluir(pg);
    assert.match(texto(pg, 'avisoAnalise'), /Não foi possível confirmar/);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/fila').length, 2);
  });

  test('isolamento: o pedido de outra empresa (ou inexistente) é "não encontrada", a análise fecha e a fila é relida', async () => {
    const { pg } = await abrir({ fila: [linha(), linha({ id: 203, numero: 33 })], detalhes: { 201: detalheDe() } });
    await analisar(pg, 203);
    assert.match(texto(pg, 'avisoFila'), /Solicitação não encontrada/);
    assert.equal(pg.visivel('analiseConteudo'), false);
    assert.equal(chamadas(pg, 'GET /solicitacoes-epi/fila').length, 2);
    for (const c of pg.chamadas) assert.equal(/empresa|usuario/i.test(c.url + JSON.stringify(c.corpo)), false, c.url);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('24–26. permissões efetivas, perfil e volta pelo histórico', () => {
  test('só APROVAR (sem REPROVAR): a fila abre, "Reprovar" fica indisponível com explicação, e nada reprova', async () => {
    const { pg } = await abrir({ p: permissoes({ acoes: { APROVAR_SOLICITACAO: true } }) });
    await analisar(pg);
    const reprovar = cartao(pg, 1).querySelector('input[type="radio"][value="REPROVADO"]');
    assert.equal(reprovar.disabled, true);
    assert.match(cartao(pg, 1).textContent, /Reprovar solicitação/);
  });

  test('sem APROVAR (só REPROVAR, ou MASTER/ADMINISTRADOR sem concessão): acesso negado e nenhuma consulta da fila — o perfil não decide', async () => {
    for (const p of [permissoes({ acoes: { REPROVAR_SOLICITACAO: true } }), permissoes({ perfil: 'MASTER', acoes: {} }), permissoes({ perfil: 'ADMINISTRADOR', acoes: {} })]) {
      const { pg } = await abrir({ p });
      assert.equal(pg.visivel('conteudoProtegido'), false, p.perfil);
      assert.equal(chamadas(pg, 'GET /solicitacoes-epi/fila').length, 0, p.perfil);
    }
  });

  test('MASTER com as duas ações efetivas trabalha a fila como qualquer pessoa autorizada (o que vale é a concessão)', async () => {
    const { pg } = await abrir({ p: permissoes({ perfil: 'MASTER', acoes: AMBAS }) });
    assert.equal(linhasDaFila(pg).length, 1);
  });

  test('volta pelo histórico com permissões alteradas: a análise e a fila somem antes de recarregar', async () => {
    const { pg, s } = await abrir();
    await analisar(pg);
    assert.match(texto(pg, 'analiseItens'), /Botina/);
    s.p = permissoes({ acoes: {} });
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.deepEqual(pg.navegacoes, ['/pages/supervisor-approval.html']);
    assert.equal(pg.textoDoDom().includes('Ana Sintética'), false);
    assert.equal(pg.textoDoDom().includes('Botina de segurança'), false);
  });

  test('volta pelo histórico com a resposta pendente: o conteúdo protegido (com a análise aberta) fica fechado até a revalidação liberar', async () => {
    const { pg, s } = await abrir();
    await analisar(pg);
    s.pendente.permissoes = true;
    const volta = pg.eventoDaJanela('pageshow', { persisted: true });
    await pg.esperar();
    assert.equal(pg.visivel('telaSessao'), true);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    s.pendente.permissoes();
    await volta;
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true, 'mesmas permissões: libera como estava');
    assert.match(texto(pg, 'analiseItens'), /Botina/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('27. semântica, acessibilidade, segurança e visual', () => {
  test('rótulos: cada decisão é um grupo com legenda; campos com rótulo; erros ligados por aria-describedby', async () => {
    const { pg } = await abrir({ detalhes: { 201: SO_GHE } });
    await analisar(pg);
    await decidir(pg, 1, 'APROVADO');
    await concluir(pg);
    const grupo = cartao(pg, 1).querySelector('fieldset');
    assert.ok(grupo && grupo.querySelector('legend'), 'fieldset com legenda');
    for (const c of pg.consulta('#analiseItens input, #analiseItens textarea').filter(pg.visivelNo)) {
      const id = c.getAttribute('id');
      assert.ok(id && pg.consulta(`label[for="${id}"]`).length === 1, `rótulo de ${id}`);
    }
    const radio2 = cartao(pg, 2).querySelector('input[type="radio"]');
    assert.ok(pg.documento.getElementById(radio2.getAttribute('aria-describedby').split(' ').pop()));
  });

  test('HTML vindo do servidor é sempre texto; nada passa por innerHTML; nada no armazenamento do navegador', async () => {
    const ATAQUE = '<img src=x onerror=alert(1)>';
    const { pg } = await abrir({
      fila: [linha({ funcionario: { id: 11, nome: ATAQUE, matricula: ATAQUE, ativo: true } })],
      detalhes: { 201: detalheDe({ observacao: ATAQUE, solicitante: { id: 9, nome: ATAQUE }, itens: [{ ...ITEM_BOTINA, justificativa: ATAQUE, material: { nome: ATAQUE, unidade: ATAQUE } }] }) },
    });
    await analisar(pg);
    assert.equal(pg.consulta('img').length, 0);
    assert.ok(pg.textoDoDom().includes(ATAQUE));
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.deepEqual(pg.storage.filter((x) => !(x.operacao === 'removeItem' || x.storage === 'cookie')), []);
  });

  test('nada de "Em integração" na página; o selo antigo e o estado de fundação saíram', async () => {
    const html = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<nav class="nav">[\s\S]*?<\/nav>/, '');
    assert.equal(/Em integração|data-area-integracao|data-estado-area|marcarEmIntegracao/.test(html), false);
  });

  for (const tema of ['light', 'dark']) {
    test(`botão desabilitado parece desabilitado (tema ${tema}): "Concluir análise" bloqueado e "Anterior" da fila em cinza, sem o azul de ação, com cursor de bloqueio`, async () => {
      const proprio = detalheDe({ solicitante: { id: 7, nome: 'Sara da Segurança' } });
      const { pg } = await abrir({ fila: [linha({ solicitanteUsuarioId: 7 })], totalFila: 25, detalhes: { 201: proprio } });
      await analisar(pg);
      pg.documento.documentElement.setAttribute('data-theme', tema);
      const tk = (nome) => token(pg, PAGINA, nome);
      const azul = tk('--primary').toLowerCase();
      for (const id of ['botaoConcluirAnalise', 'filaAnterior']) {
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
    });
  }
});
