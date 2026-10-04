'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { sessaoDeTeste } = require('./helpers/ambiente-http-12d2');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarAppTeste } = require('../helpers/app-teste');

const EpiHttp = require('../../../frontend/js/api-http');
require('../../../frontend/js/permissoes-efetivas');
const EpiSolicitacoesEpi = require('../../../frontend/js/solicitacoes-epi');
const EpiFicha = require('../../../frontend/js/epi-ficha');
const EpiEntregasSolicitacao = require('../../../frontend/js/entregas-solicitacao');

/**
 * 12G-4 — as Entregas por solicitação do frontend contra o servidor HTTP real e
 * o PostgreSQL real (schema temporário com todas as migrations): a lista, o
 * detalhe e os lotes trazem o que a tela lê; o que a tela calcula a partir
 * deles (disponível agora, lotes do item, sugestão FIFO) é o que o servidor
 * aceita; o corpo que a tela monta é aceito, com a mesma chave na repetição; as
 * recusas por cobertura, pendente, saldo, lote e CA têm o código que a tela
 * traduz; o encerramento, a autoridade por ação e o isolamento por empresa são
 * os do servidor. Rotas reais da solicitação e da entrega; a única peça de
 * teste é a sessão.
 */

const S = EpiSolicitacoesEpi;
const F = EpiFicha;
const R = EpiEntregasSolicitacao.rascunho;
const TEXTOS = EpiEntregasSolicitacao.TEXTOS;

describe('12G-4 — Entregas por solicitação do frontend contra servidor e PostgreSQL reais', () => {
  let env;
  let servidor;
  let base;
  const u = {};

  before(async () => {
    env = await montarAmbiente12f();
    const { pool, d } = env;
    const rotasSolicitacao = exigirModulo('src/routes/solicitacao-epi.routes');
    const controllerSolicitacao = exigirModulo('src/controllers/solicitacao-epi.controller');
    const rotasEntrega = exigirModulo('src/routes/entrega-epi.routes');
    const controllerEntrega = exigirModulo('src/controllers/entrega-epi.controller');
    const exigirSessao = sessaoDeTeste(pool);
    const relogio = () => new Date();
    // As rotas que a tela usa: as da solicitação (12F) e o contexto da entrega (Bloco 10).
    const app = criarAppTeste((a) => {
      a.use(
        '/api',
        rotasSolicitacao.criarSolicitacaoEpiRoutes({ controller: controllerSolicitacao.criarSolicitacaoEpiController({ pool, relogio }), exigirSessao, pool }),
        rotasEntrega.criarEntregaEpiRoutes({ controller: controllerEntrega.criarEntregaEpiController({ pool, relogio }), exigirSessao, pool }),
      );
    });
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    u.entregador = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    u.encerrador = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['ENCERRAR_SOLICITACAO'], sst: true });
    u.entregadorB = await env.usuarioCom(d.empresaB, { acoes: ['REALIZAR_ENTREGA'] });
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (env) await env.encerrar();
  });

  const comoUsuario = (usuarioId) => {
    EpiHttp.configurar({
      baseUrl: `${base}/api`,
      fetch: (url, opcoes = {}) => fetch(url, { ...opcoes, headers: { ...(opcoes.headers || {}), 'x-teste-usuario': String(usuarioId) } }),
    });
  };

  /** O que a tela faz ao preparar: o detalhe, os lotes de cada item com algo disponível agora e a sugestão FIFO. */
  async function prepararComoATela(id) {
    const detalhe = await S.acoes.detalhe(id);
    assert.equal(detalhe.status, 200, JSON.stringify(detalhe));
    const lotesPorItem = {};
    const alocacoes = {};
    for (const item of detalhe.dados.itens.filter((i) => R.disponivelAgora(i) > 0)) {
      const r = await F.acoes.lotes(detalhe.dados.solicitacao.funcionarioId, item.materialId);
      assert.equal(r.status, 200, JSON.stringify(r));
      lotesPorItem[item.id] = R.lotesDoItem(item, r.dados.lotes);
      alocacoes[item.id] = R.sugestaoFifo(item, lotesPorItem[item.id]);
    }
    return { detalhe, lotesPorItem, alocacoes };
  }

  const ACEITE = { modo: 'ACEITE_PRESENCIAL' };
  const entregar = (id, corpo, estado = F.idempotencia.novoEstado()) => S.acoes.entregar(id, { ...corpo, chaveIdempotencia: F.idempotencia.chavePara(estado, corpo) });
  const cru = (id, itens) => S.acoes.entregar(id, { ...R.corpo(itens, ACEITE), chaveIdempotencia: F.idempotencia.gerar() });

  test('lista, detalhe e lotes trazem o que a tela lê: disponível agora pela cobertura do servidor; só lotes do tamanho, com CA válido, na ordem da validade; sem CPF', async () => {
    const { f, d } = env;
    const m = await f.material();
    const tarde = await f.estoque(m, 2, { caValidade: '2099-06-30' });
    const cedo = await f.estoque(m, 1, { caValidade: '2099-01-31' });
    await f.estoque(m, 9, { tamanho: '41' });
    await f.estoque(m, 3, { caValidade: '2020-01-01' });
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 4 });
    comoUsuario(u.entregador);
    const lista = await S.acoes.entregaveis({ pagina: 1, limite: EpiEntregasSolicitacao.LIMITE_LISTA });
    assert.equal(lista.status, 200, JSON.stringify(lista));
    const linha = lista.dados.solicitacoes.find((s) => s.id === id);
    assert.ok(linha, 'a aprovada está nos entregáveis');
    for (const k of ['numero', 'status', 'situacaoOperacional', 'criadaEm', 'decididaEm']) assert.ok(k in linha, k);
    assert.deepEqual([linha.status, linha.situacaoOperacional, linha.funcionario.id, linha.quantidades.aprovada, linha.quantidades.restante], ['APROVADA', 'PARCIALMENTE_COBERTA', d.trabalhador, 4, 4]);
    const { detalhe, lotesPorItem, alocacoes } = await prepararComoATela(id);
    const it = detalhe.dados.itens.find((i) => i.id === item);
    assert.deepEqual([it.decisao, it.quantidadeAprovada, it.quantidadeEntregue, it.quantidadePendente, it.cobertura.coberta, it.situacao], ['APROVADO', 4, 0, 4, 3, 'PARCIALMENTE_COBERTA']);
    assert.equal(R.disponivelAgora(it), 3);
    assert.deepEqual(lotesPorItem[item].map((l) => l.loteId), [cedo, tarde], 'sem o lote de outro tamanho e sem o de CA vencido, do que vence primeiro para o que vence depois');
    assert.deepEqual(alocacoes[item], { [cedo]: '1', [tarde]: '2' });
    assert.equal(/"cpf"|"email"/.test(JSON.stringify([lista.dados, detalhe.dados])), false);
  });

  test('entrega com dois lotes pelo corpo que a tela monta: 201 com a ficha; a repetição com a mesma chave é 200 "repetida", sem nova entrega; o detalhe relido mostra entregue e pendente', async () => {
    const { f } = env;
    const m = await f.material();
    const a = await f.estoque(m, 1, { caValidade: '2099-01-31' });
    const b = await f.estoque(m, 5, { caValidade: '2099-06-30' });
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 3 });
    comoUsuario(u.entregador);
    const { detalhe, lotesPorItem, alocacoes } = await prepararComoATela(id);
    alocacoes[item][b] = '1';
    const v = R.validar(detalhe.dados.itens, alocacoes, lotesPorItem);
    assert.equal(v.ok, true, JSON.stringify(v));
    const corpo = R.corpo(v.itens, ACEITE);
    assert.deepEqual(corpo.itens, [{ solicitacaoItemId: item, loteId: a, quantidade: 1 }, { solicitacaoItemId: item, loteId: b, quantidade: 1 }]);
    const estado = F.idempotencia.novoEstado();
    const r = await entregar(id, corpo, estado);
    assert.equal(r.status, 201, JSON.stringify(r));
    assert.deepEqual([r.dados.repetida, typeof r.dados.entrega.ficha.numero], [false, 'number']);
    const denovo = await entregar(id, corpo, estado);
    assert.deepEqual([denovo.status, denovo.dados.repetida, denovo.dados.entrega.id], [200, true, r.dados.entrega.id]);
    const relido = (await S.acoes.detalhe(id)).dados;
    const it = relido.itens.find((i) => i.id === item);
    assert.deepEqual([relido.solicitacao.status, it.quantidadeEntregue, it.quantidadePendente, it.situacao], ['APROVADA', 2, 1, 'PARCIALMENTE_ENTREGUE']);
    assert.equal(R.disponivelAgora(it), 1);
  });

  test('assinatura desenhada coletada como a tela coleta (mesmo coletor da Ficha) é aceita; a última entrega leva a solicitação a ENTREGUE, que sai da lista', async () => {
    const { f } = env;
    const m = await f.material();
    await f.estoque(m, 2);
    const { id } = await f.aprovada({ materialId: m, quantidade: 2 });
    comoUsuario(u.entregador);
    const { detalhe, lotesPorItem, alocacoes } = await prepararComoATela(id);
    const coletor = F.tracos.criarColetor();
    coletor.iniciar();
    for (const [x, y] of [[100, 120], [300, 200], [600, 180]]) coletor.ponto(x, y, 1040, 400);
    coletor.encerrar();
    const v = R.validar(detalhe.dados.itens, alocacoes, lotesPorItem);
    const r = await entregar(id, R.corpo(v.itens, { modo: 'DESENHO', tracos: coletor.valores() }));
    assert.equal(r.status, 201, JSON.stringify(r));
    assert.equal(r.dados.solicitacao.status, 'ENTREGUE');
    const lista = await S.acoes.entregaveis({ pagina: 1, limite: 100 });
    assert.equal(lista.dados.solicitacoes.some((s) => s.id === id), false);
  });

  test('acima da cobertura (a fila dá o estoque a quem foi aprovado antes): a tela recusa antes; o servidor também, 409 QUANTIDADE_ACIMA_DA_COBERTURA, com texto próprio da tela', async () => {
    const { f } = env;
    const m = await f.material();
    const lote = await f.estoque(m, 3);
    await f.aprovada({ materialId: m, quantidade: 2 });
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 2 });
    comoUsuario(u.entregador);
    const { detalhe, lotesPorItem } = await prepararComoATela(id);
    const it = detalhe.dados.itens.find((i) => i.id === item);
    assert.equal(R.disponivelAgora(it), 1, 'a primeira aprovada fica com 2 dos 3');
    const v = R.validar(detalhe.dados.itens, { [item]: { [lote]: '2' } }, lotesPorItem);
    assert.deepEqual(v.erros.map((e) => [e.itemId, e.campo]), [[item, 'item']]);
    const r = await cru(id, [{ solicitacaoItemId: item, loteId: lote, quantidade: 2 }]);
    assert.deepEqual([r.status, r.codigo], [409, 'QUANTIDADE_ACIMA_DA_COBERTURA']);
    assert.match(TEXTOS[r.codigo], /estoque disponível para este pedido mudou/);
  });

  test('acima do pendente: a tela recusa antes; o servidor também, 409 QUANTIDADE_ACIMA_DO_PENDENTE', async () => {
    const { f } = env;
    const m = await f.material();
    const lote = await f.estoque(m, 5);
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 1 });
    comoUsuario(u.entregador);
    const { detalhe, lotesPorItem } = await prepararComoATela(id);
    assert.equal(R.validar(detalhe.dados.itens, { [item]: { [lote]: '2' } }, lotesPorItem).ok, false);
    const r = await cru(id, [{ solicitacaoItemId: item, loteId: lote, quantidade: 2 }]);
    assert.deepEqual([r.status, r.codigo], [409, 'QUANTIDADE_ACIMA_DO_PENDENTE']);
    assert.match(TEXTOS[r.codigo], /quantidade pendente mudou/);
  });

  test('acima do saldo do lote (coberta pelo par): a tela recusa no lote; o servidor também, 409 SALDO_INSUFICIENTE', async () => {
    const { f } = env;
    const m = await f.material();
    const pequeno = await f.estoque(m, 1, { caValidade: '2099-01-31' });
    await f.estoque(m, 2, { caValidade: '2099-06-30' });
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 3 });
    comoUsuario(u.entregador);
    const { detalhe, lotesPorItem } = await prepararComoATela(id);
    const v = R.validar(detalhe.dados.itens, { [item]: { [pequeno]: '2' } }, lotesPorItem);
    assert.deepEqual(v.erros.map((e) => [e.loteId, e.mensagem]), [[pequeno, 'Este lote tem só 1.']]);
    const r = await cru(id, [{ solicitacaoItemId: item, loteId: pequeno, quantidade: 2 }]);
    assert.deepEqual([r.status, r.codigo], [409, 'SALDO_INSUFICIENTE']);
    assert.match(TEXTOS[r.codigo], /saldo do lote mudou/);
  });

  test('lote de outro tamanho e lote de CA vencido: a tela nunca os oferece; o servidor recusa (LOTE_DIVERGENTE_DO_ITEM, CA_VENCIDO), e a tela relê com texto próprio', async () => {
    const { f } = env;
    const m = await f.material();
    await f.estoque(m, 4);
    const outroTamanho = await f.estoque(m, 4, { tamanho: '41' });
    const vencido = await f.estoque(m, 4, { caValidade: '2020-01-01' });
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 1 });
    comoUsuario(u.entregador);
    const { lotesPorItem } = await prepararComoATela(id);
    assert.equal(lotesPorItem[item].some((l) => l.loteId === outroTamanho || l.loteId === vencido), false);
    for (const [loteId, codigo] of [[outroTamanho, 'LOTE_DIVERGENTE_DO_ITEM'], [vencido, 'CA_VENCIDO']]) {
      const r = await cru(id, [{ solicitacaoItemId: item, loteId, quantidade: 1 }]);
      assert.deepEqual([r.status, r.codigo], [409, codigo]);
      assert.ok(TEXTOS[codigo], codigo);
    }
  });

  test('encerramento: a justificativa que a tela normaliza é aceita; ENCERRADA sai das duas listas; entregar depois é 409 SOLICITACAO_NAO_ENTREGAVEL; o segundo encerramento é 409 SOLICITACAO_NAO_ENCERRAVEL', async () => {
    const { f } = env;
    const m = await f.material();
    const lote = await f.estoque(m, 5);
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 2 });
    comoUsuario(u.encerrador);
    const encerraveis = await S.acoes.encerraveis({ pagina: 1, limite: 100 });
    assert.equal(encerraveis.status, 200, JSON.stringify(encerraveis));
    assert.ok(encerraveis.dados.solicitacoes.some((s) => s.id === id));
    const vazio = await S.acoes.encerrar(id, { justificativa: '   ' });
    assert.deepEqual([vazio.status, vazio.detalhes[0].codigo], [400, 'JUSTIFICATIVA_OBRIGATORIA']);
    assert.deepEqual(R.justificativaDoEncerramento('   '), { ok: false, mensagem: TEXTOS.JUSTIFICATIVA_OBRIGATORIA });
    const j = R.justificativaDoEncerramento('  Trabalhador desligado  ');
    const r = await S.acoes.encerrar(id, { justificativa: j.valor });
    assert.deepEqual([r.status, r.dados.solicitacao.status], [200, 'ENCERRADA']);
    assert.equal((await S.acoes.encerraveis({ pagina: 1, limite: 100 })).dados.solicitacoes.some((s) => s.id === id), false);
    const denovo = await S.acoes.encerrar(id, { justificativa: 'De novo' });
    assert.deepEqual([denovo.status, denovo.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL']);
    assert.match(TEXTOS[denovo.codigo], /não pode ser encerrada/);
    comoUsuario(u.entregador);
    assert.equal((await S.acoes.entregaveis({ pagina: 1, limite: 100 })).dados.solicitacoes.some((s) => s.id === id), false);
    const detalhe = (await S.acoes.detalhe(id)).dados;
    assert.equal(detalhe.solicitacao.status, 'ENCERRADA');
    const entrega = await cru(id, [{ solicitacaoItemId: item, loteId: lote, quantidade: 1 }]);
    assert.deepEqual([entrega.status, entrega.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
    assert.match(TEXTOS[entrega.codigo], /não pode mais receber entrega/);
  });

  test('autoridade por ação: quem só entrega não encerra nem lista as encerráveis; quem só encerra não lista os entregáveis, não vê lotes e não entrega (403)', async () => {
    const { f, d } = env;
    const m = await f.material();
    const lote = await f.estoque(m, 2);
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 1 });
    comoUsuario(u.entregador);
    for (const r of [await S.acoes.encerraveis({ pagina: 1, limite: 20 }), await S.acoes.encerrar(id, { justificativa: 'x' })]) assert.deepEqual([r.status, r.codigo], [403, 'PERMISSAO_NEGADA']);
    comoUsuario(u.encerrador);
    for (const r of [
      await S.acoes.entregaveis({ pagina: 1, limite: 20 }),
      await F.acoes.lotes(d.trabalhador, m),
      await cru(id, [{ solicitacaoItemId: item, loteId: lote, quantidade: 1 }]),
    ]) assert.deepEqual([r.status, r.codigo], [403, 'PERMISSAO_NEGADA']);
  });

  test('isolamento por empresa: quem entrega na outra empresa não vê o pedido e recebe o mesmo 404 do inexistente, no detalhe e na entrega; os lotes do trabalhador alheio também não', async () => {
    const { f, d } = env;
    const m = await f.material();
    const lote = await f.estoque(m, 2);
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 1 });
    comoUsuario(u.entregadorB);
    assert.equal((await S.acoes.entregaveis({ pagina: 1, limite: 100 })).dados.solicitacoes.some((s) => s.id === id), false);
    const alheio = await S.acoes.detalhe(id);
    const inexistente = await S.acoes.detalhe(2147483000);
    assert.deepEqual([alheio.status, alheio.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
    assert.deepEqual([alheio.status, alheio.codigo], [inexistente.status, inexistente.codigo]);
    const entrega = await cru(id, [{ solicitacaoItemId: item, loteId: lote, quantidade: 1 }]);
    assert.deepEqual([entrega.status, entrega.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
    assert.equal((await F.acoes.lotes(d.trabalhador, m)).status, 404);
  });

  test('trabalhador inativado depois da aprovação: o item fica SUSPENSA, sem cobertura (nada disponível agora), os lotes dizem FUNCIONARIO_INATIVO e a entrega é 409 SOLICITACAO_NAO_ENTREGAVEL', async () => {
    const { f, d, pool } = env;
    const m = await f.material();
    const lote = await f.estoque(m, 2);
    const { id, item } = await f.aprovada({ materialId: m, quantidade: 1, funcionarioId: d.trabalhador3 });
    await pool.query('UPDATE funcionarios SET ativo = false WHERE id = $1', [d.trabalhador3]);
    try {
      comoUsuario(u.entregador);
      const it = (await S.acoes.detalhe(id)).dados.itens.find((i) => i.id === item);
      assert.deepEqual([it.situacao, it.cobertura, R.disponivelAgora(it)], ['SUSPENSA', null, 0]);
      const lotes = await F.acoes.lotes(d.trabalhador3, m);
      assert.deepEqual([lotes.status, lotes.codigo], [409, 'FUNCIONARIO_INATIVO']);
      assert.match(TEXTOS[lotes.codigo], /trabalhador está inativo/);
      const entrega = await cru(id, [{ solicitacaoItemId: item, loteId: lote, quantidade: 1 }]);
      assert.deepEqual([entrega.status, entrega.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
    } finally {
      await pool.query('UPDATE funcionarios SET ativo = true WHERE id = $1', [d.trabalhador3]);
    }
  });
});
