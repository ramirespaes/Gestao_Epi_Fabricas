'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');

const EpiHttp = require('../../../frontend/js/api-http');
require('../../../frontend/js/permissoes-efetivas');
const EpiSolicitacoesEpi = require('../../../frontend/js/solicitacoes-epi');
const EpiFicha = require('../../../frontend/js/epi-ficha');
const EpiPedidoEpi = require('../../../frontend/js/pedido-epi');

/**
 * 12G-2 — o Pedido de EPI do frontend contra o servidor HTTP real e o
 * PostgreSQL real (schema temporário com todas as migrations): o corpo que a
 * tela monta (EpiPedidoEpi.rascunho.validar + EpiFicha.idempotencia) é aceito
 * pelas rotas, schemas e serviços de produção; os campos que a tela lê de
 * "minhas" e do detalhe existem; os códigos de erro que ela traduz são os que o
 * servidor devolve. A única peça de teste é a sessão (x-teste-usuario).
 */

const S = EpiSolicitacoesEpi;

describe('12G-2 — Pedido de EPI do frontend contra servidor e PostgreSQL reais', () => {
  let env;
  let servidor;
  let base;
  let solicitante;
  let outro;

  before(async () => {
    env = await montarAmbiente12f();
    servidor = http.createServer(env.app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    solicitante = await env.usuarioCom(env.d.empresaA, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    outro = await env.usuarioCom(env.d.empresaA, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
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

  /** O que a tela faz ao escolher o trabalhador: busca e EPIs previstos no GHE dele. */
  async function contextoDaTela() {
    const trabalhadores = await S.acoes.contextoFuncionarios({ busca: 'T-', limite: 20 });
    assert.equal(trabalhadores.ok, true, JSON.stringify(trabalhadores));
    const trabalhador = trabalhadores.dados.funcionarios.find((f) => f.id === env.d.trabalhador);
    assert.ok(trabalhador);
    const r = await S.acoes.contextoMateriais(trabalhador.id, { previstoNoGhe: true, pagina: 1, limite: 100 });
    assert.equal(r.ok, true, JSON.stringify(r));
    return { trabalhador, materiais: Object.fromEntries(r.dados.materiais.map((m) => [m.id, m])) };
  }

  const rascunho = ({ trabalhador, materiais }, itens, observacao = '') => ({
    funcionario: trabalhador, materiais, itens: itens.map((i) => ({ ...EpiPedidoEpi.rascunho.novoItem(), ...i })), observacao,
  });

  test('o trabalhador e os EPIs que a tela mostra: só ativos, sem CPF; só os previstos no GHE (o GHE dá o direito, não o estoque)', async () => {
    comoUsuario(solicitante);
    const ctx = await contextoDaTela();
    const { materiais } = ctx;
    assert.equal('cpf' in ctx.trabalhador, false);
    assert.deepEqual(Object.keys(materiais).map(Number).sort((a, b) => a - b), [env.d.botina, env.d.capacete].sort((a, b) => a - b), 'a luva é do outro GHE e não aparece');
    assert.equal(materiais[env.d.botina].exigeTamanho, true);
    assert.equal(materiais[env.d.capacete].exigeTamanho, false);
  });

  test('envio da tela: 201 sem estoque nenhum; a mesma chave com o mesmo rascunho é a repetição (200); "minhas" e o detalhe trazem o que a tela lê', async () => {
    comoUsuario(solicitante);
    const ctx = await contextoDaTela();
    const { trabalhador } = ctx;
    const v = EpiPedidoEpi.rascunho.validar(rascunho(ctx, [
      { materialId: env.d.botina, tamanho: ' 40 ', quantidade: '2', motivo: 'DESGASTE_DANO' },
      { materialId: env.d.capacete, quantidade: '1', motivo: 'OUTRO', justificativa: 'Capacete trincado' },
    ], 'Turno da noite'));
    assert.equal(v.ok, true, JSON.stringify(v.erros));
    const idem = EpiFicha.idempotencia.novoEstado();
    const corpo = { ...v.corpo, chaveIdempotencia: EpiFicha.idempotencia.chavePara(idem, v.corpo) };
    const criado = await S.acoes.criar(corpo);
    assert.deepEqual([criado.status, criado.dados.repetida], [201, false], JSON.stringify(criado));
    const repetido = await S.acoes.criar({ ...v.corpo, chaveIdempotencia: EpiFicha.idempotencia.chavePara(idem, v.corpo) });
    assert.deepEqual([repetido.status, repetido.dados.repetida, repetido.dados.solicitacao.id], [200, true, criado.dados.solicitacao.id]);

    const minhas = await S.acoes.minhas({ pagina: 1, limite: 10 });
    const linha = minhas.dados.solicitacoes.find((s) => s.id === criado.dados.solicitacao.id);
    assert.ok(linha);
    for (const k of ['numero', 'status', 'criadaEm', 'quantidadeItens']) assert.ok(k in linha, k);
    assert.deepEqual([linha.funcionario.nome, typeof linha.funcionario.matricula, linha.quantidades.solicitada], [trabalhador.nome, 'string', 3]);

    const detalhe = await S.acoes.detalhe(criado.dados.solicitacao.id);
    const s = detalhe.dados.solicitacao;
    assert.deepEqual([s.status, s.observacao, s.funcionario.nome, s.solicitante.id], ['PENDENTE', 'Turno da noite', trabalhador.nome, solicitante]);
    for (const k of ['matricula', 'setor', 'funcao', 'ativo']) assert.ok(k in s.funcionario, k);
    const porMaterial = Object.fromEntries(detalhe.dados.itens.map((i) => [i.materialId, i]));
    assert.deepEqual([porMaterial[env.d.botina].tamanho, porMaterial[env.d.botina].quantidade, porMaterial[env.d.botina].motivo, porMaterial[env.d.botina].material.nome], ['40', 2, 'DESGASTE_DANO', 'Botina de segurança']);
    assert.deepEqual([porMaterial[env.d.capacete].tamanho, porMaterial[env.d.capacete].justificativa], [null, 'Capacete trincado']);
    const textoDetalhe = JSON.stringify(detalhe.dados);
    assert.equal(/"cpf"|"email"|"cobertura"|"posicao"/.test(textoDetalhe), false, 'quem pede não recebe CPF, e-mail nem estoque');
  });

  test('o que o servidor recusa chega à tela com o texto certo: tamanho, justificativa do "Outro", item repetido e chave já usada', async () => {
    comoUsuario(solicitante);
    const { trabalhador } = await contextoDaTela();
    const semTamanho = await S.acoes.criar({ funcionarioId: trabalhador.id, itens: [{ materialId: env.d.botina, tamanho: null, quantidade: 1, motivo: 'ADMISSAO', justificativa: null }], observacao: null, chaveIdempotencia: EpiFicha.idempotencia.gerar() });
    assert.deepEqual(S.mensagens.deCampos(semTamanho).map((c) => [c.campo, c.mensagem]), [['body.itens[0].tamanho', 'Informe o tamanho deste EPI.']]);
    const outroSem = await S.acoes.criar({ funcionarioId: trabalhador.id, itens: [{ materialId: env.d.capacete, tamanho: null, quantidade: 1, motivo: 'OUTRO', justificativa: null }], observacao: null, chaveIdempotencia: EpiFicha.idempotencia.gerar() });
    assert.deepEqual(S.mensagens.deCampos(outroSem).map((c) => c.mensagem), ['Explique o motivo deste item.']);
    const repetido = await S.acoes.criar({
      funcionarioId: trabalhador.id,
      itens: [{ materialId: env.d.capacete, tamanho: null, quantidade: 1, motivo: 'ADMISSAO', justificativa: null }, { materialId: env.d.capacete, tamanho: null, quantidade: 2, motivo: 'ADMISSAO', justificativa: null }],
      observacao: null,
      chaveIdempotencia: EpiFicha.idempotencia.gerar(),
    });
    assert.deepEqual(S.mensagens.deCampos(repetido).map((c) => c.mensagem), ['Cada EPI e tamanho aparece uma vez só no pedido.']);
    const chave = EpiFicha.idempotencia.gerar();
    const base1 = { funcionarioId: trabalhador.id, itens: [{ materialId: env.d.capacete, tamanho: null, quantidade: 1, motivo: 'ADMISSAO', justificativa: null }], observacao: null };
    assert.equal((await S.acoes.criar({ ...base1, chaveIdempotencia: chave })).status, 201);
    const conflito = await S.acoes.criar({ ...base1, observacao: 'outra', chaveIdempotencia: chave });
    assert.deepEqual([conflito.status, conflito.codigo, S.mensagens.deErro(conflito)], [409, 'IDEMPOTENCIA_CONFLITO', 'Este envio conflita com um pedido anterior. Revise os dados e envie de novo.']);
  });

  test('cancelamento da tela: o próprio pendente cancela; de novo é 409 com o texto da tela; o de outra pessoa é o mesmo "não encontrada"', async () => {
    comoUsuario(solicitante);
    const ctx = await contextoDaTela();
    const v = EpiPedidoEpi.rascunho.validar(rascunho(ctx, [{ materialId: env.d.capacete, quantidade: '1', motivo: 'ADMISSAO' }]));
    const criado = await S.acoes.criar({ ...v.corpo, chaveIdempotencia: EpiFicha.idempotencia.gerar() });
    const id = criado.dados.solicitacao.id;
    comoUsuario(outro);
    const alheio = await S.acoes.cancelar(id, { justificativa: null });
    assert.deepEqual([alheio.status, S.mensagens.deErro(alheio)], [404, 'Solicitação não encontrada.']);
    comoUsuario(solicitante);
    const cancelado = await S.acoes.cancelar(id, { justificativa: null });
    assert.deepEqual([cancelado.status, cancelado.dados.solicitacao.status], [200, 'CANCELADA']);
    const denovo = await S.acoes.cancelar(id, { justificativa: 'tarde demais' });
    assert.deepEqual([denovo.status, denovo.codigo, S.mensagens.deErro(denovo)], [409, 'SOLICITACAO_NAO_PENDENTE', 'Este pedido já foi decidido ou cancelado e não pode mais ser cancelado.']);
    const detalhe = await S.acoes.detalhe(id);
    assert.deepEqual([detalhe.dados.solicitacao.status, detalhe.dados.solicitacao.cancelamento.justificativa], ['CANCELADA', null]);
  });
});
