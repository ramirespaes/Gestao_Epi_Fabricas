'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { vincularMaterialAoGhe, chaveNova } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const { inserir } = require('./helpers/entrega-epi');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const entregaSvc = require('../../src/services/entrega-solicitacao.service');

/**
 * Decisão e encerramento da solicitação de EPI pela camada HTTP (12F-2), contra
 * PostgreSQL real, com as rotas, autorizações, schemas e serviços de produção:
 *   POST /api/solicitacoes-epi/:id/decisao      aprovar exige APROVAR_SOLICITACAO,
 *                                               reprovar exige REPROVAR_SOLICITACAO,
 *                                               a decisão mista exige as duas;
 *   POST /api/solicitacoes-epi/:id/encerramento ENCERRAR_SOLICITACAO.
 * As três ações exigem SST e autorização individual (OBRIGATORIA), pela
 * autorização central; nenhuma entra no provisionamento do MASTER. Quem criou
 * não aprova nem reprova a própria (AUTODECISAO_PROIBIDA), mas pode encerrá-la
 * com autoridade válida. Outra empresa recebe o mesmo 404 da inexistente.
 */

const ID_INEXISTENTE = 2147483000;
const JUSTIFICATIVA_ENCERRAMENTO = 'Trabalhador transferido para outra unidade';
const decisao = (id) => `/api/solicitacoes-epi/${id}/decisao`;
const encerramento = (id) => `/api/solicitacoes-epi/${id}/encerramento`;

describe('decisão e encerramento HTTP da solicitação de EPI (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};

  const q = (sql, params) => pool.query(sql, params);
  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const linha = async (id) => (await q(
    'SELECT status, decidida_por, encerrada_por, justificativa_encerramento FROM solicitacoes_epi WHERE id = $1', [id],
  )).rows[0];
  const statusDe = async (criada) => (await linha(criada.solicitacao.id)).status;
  const auditorias = async (acao, referencia) => (await q(
    'SELECT usuario_id, descricao, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id', [acao, String(referencia)],
  )).rows;
  const criar = async (atorId, materialId, {
    empresaId = d.empresaA, funcionarioId = d.trabalhador, quantidade = 2, tamanho = '40', outros = [],
  } = {}) => solicitacaoSvc.criarSolicitacao(pool, {
    empresaId, atorId, funcionarioId, itens: [{ materialId, tamanho, quantidade, motivo: 'ADMISSAO' }, ...outros], chaveIdempotencia: chaveNova(),
  });
  const aprovarTudo = (criada) => criada.itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO' }));
  const reprovarTudo = (criada) => criada.itens.map((i) => ({ itemId: i.id, decisao: 'REPROVADO', justificativa: 'Sem necessidade comprovada' }));
  const decidirPeloServico = (criada, decisoes, { empresaId = d.empresaA, decisor = d.sst1 } = {}) => solicitacaoSvc.decidirSolicitacao(pool, {
    empresaId, atorId: decisor, solicitacaoId: criada.solicitacao.id, decisoes, hoje: f.HOJE,
  });
  const aprovada = async (atorId, materialId, opcoes = {}) => {
    const criada = await criar(atorId, materialId, opcoes);
    await decidirPeloServico(criada, aprovarTudo(criada), opcoes);
    return criada;
  };

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const A = d.empresaA;
    const B = d.empresaB;
    const SST = { perfil: 'ADMINISTRADOR', sst: true };
    u.solicitante = await env.usuarioCom(A, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.aprovador = await env.usuarioCom(A, { ...SST, acoes: ['APROVAR_SOLICITACAO'] });
    u.reprovador = await env.usuarioCom(A, { ...SST, acoes: ['REPROVAR_SOLICITACAO'] });
    u.decisor = await env.usuarioCom(A, { ...SST, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'] });
    u.decisorSemVinculo = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'] });
    u.encerrador = await env.usuarioCom(A, { ...SST, acoes: ['ENCERRAR_SOLICITACAO'] });
    u.encerradorSemVinculo = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['ENCERRAR_SOLICITACAO'] });
    u.sstSemEncerrar = await env.usuarioCom(A, { ...SST, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'] });
    u.sstCompleto = await env.usuarioCom(A, {
      ...SST, recursos: { request: ['visualizar', 'criar', 'editar'] }, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'],
    });
    u.semNada = await env.usuarioCom(A);
    u.solicitanteB = await env.usuarioCom(B, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.sstB = await env.usuarioCom(B, { ...SST, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'] });
    await vincularMaterialAoGhe(pool, B, d.gheB, d.botinaB);
  });

  after(async () => { if (env) await env.encerrar(); });

  describe('POST /solicitacoes-epi/:id/decisao — aprovação', () => {
    test('200 APROVADA: decidida pelo usuário da sessão; quem decide vê cobertura e posição; a demanda passa a contar no par (Modelo A); auditoria sem texto livre', async () => {
      const m = await f.material();
      await f.estoque(m, 1);
      const criada = await criar(u.solicitante, m);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 0, 0, 1, 0]);
      const r = await como(u.decisor).post(decisao(criada.solicitacao.id), { decisoes: aprovarTudo(criada) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.status, r.body.solicitacao.status, r.body.solicitacao.decisao.decididaPor], ['ok', 'APROVADA', u.decisor]);
      assert.deepEqual([r.body.itens[0].cobertura.coberta, r.body.itens[0].cobertura.semCobertura], [1, 1]);
      assert.deepEqual([r.body.itens[0].posicao.demandaPendente, r.body.itens[0].posicao.saldoLivre], [2, 0]);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 2, 1, 0, 1]);
      assert.equal((await linha(criada.solicitacao.id)).decidida_por, u.decisor);
      const [registro] = await auditorias('SOLICITACAO_EPI_DECIDIDA', criada.solicitacao.id);
      assert.deepEqual([registro.usuario_id, registro.descricao, registro.contexto.resultado], [u.decisor, null, 'APROVADA']);
    });

    test('fora do GHE: aprovar sem justificativa é 400 JUSTIFICATIVA_FORA_GHE_OBRIGATORIA e continua PENDENTE; com ela é 200 e a justificativa fica na decisão do item', async () => {
      const foraDoGhe = await f.material({ previsto: false });
      const criada = await criar(u.solicitante, foraDoGhe);
      const sem = await como(u.decisor).post(decisao(criada.solicitacao.id), { decisoes: aprovarTudo(criada) });
      assert.deepEqual([sem.status, sem.body.codigo], [400, 'VALIDACAO']);
      assert.ok(sem.body.detalhes.some((x) => x.codigo === 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA'), JSON.stringify(sem.body));
      assert.equal(await statusDe(criada), 'PENDENTE');
      const com = await como(u.decisor).post(decisao(criada.solicitacao.id), {
        decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO', justificativa: 'Exposição a respingos químicos na função atual' }],
      });
      assert.equal(com.status, 200, JSON.stringify(com.body));
      assert.deepEqual([com.body.itens[0].previstoNoGhe, com.body.itens[0].justificativaDecisao], [false, 'Exposição a respingos químicos na função atual']);
    });

    test('sem a ação certa: quem só reprova não aprova; sem nada; MASTER provisionado (as ações da SST não entram no escopo dele): o mesmo 403 PERMISSAO_NEGADA', async () => {
      const criada = await criar(u.solicitante, await f.material());
      const respostas = [];
      for (const usuario of [u.reprovador, u.semNada, d.master]) respostas.push(resposta(await como(usuario).post(decisao(criada.solicitacao.id), { decisoes: aprovarTudo(criada) })));
      assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
      for (const r of respostas) assert.deepEqual(r, respostas[0]);
      assert.equal(await statusDe(criada), 'PENDENTE');
    });

    test('sem vínculo SST: mesmo com as autorizações individuais, o mesmo 403 PERMISSAO_NEGADA', async () => {
      const criada = await criar(u.solicitante, await f.material());
      const semVinculo = resposta(await como(u.decisorSemVinculo).post(decisao(criada.solicitacao.id), { decisoes: aprovarTudo(criada) }));
      const semAcao = resposta(await como(u.semNada).post(decisao(criada.solicitacao.id), { decisoes: aprovarTudo(criada) }));
      assert.deepEqual(semVinculo, semAcao);
      assert.equal(semVinculo.status, 403);
      assert.equal(await statusDe(criada), 'PENDENTE');
    });

    test('outra empresa: decidir a da outra é o mesmo 404 da inexistente (corpo idêntico), nos dois sentidos; nada muda', async () => {
      const daA = await criar(u.solicitante, await f.material());
      const daB = await criar(u.solicitanteB, d.botinaB, { empresaId: d.empresaB, funcionarioId: d.trabalhadorB });
      const inexistente = resposta(await como(u.decisor).post(decisao(ID_INEXISTENTE), { decisoes: aprovarTudo(daB) }));
      const cruzada = resposta(await como(u.decisor).post(decisao(daB.solicitacao.id), { decisoes: aprovarTudo(daB) }));
      assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzada, inexistente);
      const inexistenteB = resposta(await como(u.sstB).post(decisao(ID_INEXISTENTE), { decisoes: aprovarTudo(daA) }));
      const cruzadaB = resposta(await como(u.sstB).post(decisao(daA.solicitacao.id), { decisoes: aprovarTudo(daA) }));
      assert.deepEqual([inexistenteB.status, inexistenteB.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzadaB, inexistenteB);
      assert.deepEqual([await statusDe(daA), await statusDe(daB)], ['PENDENTE', 'PENDENTE']);
    });

    test('repetição: a segunda decisão é 409 SOLICITACAO_NAO_PENDENTE; uma auditoria de decisão só', async () => {
      const criada = await criar(u.solicitante, await f.material());
      assert.equal((await como(u.decisor).post(decisao(criada.solicitacao.id), { decisoes: aprovarTudo(criada) })).status, 200);
      const segunda = await como(u.decisor).post(decisao(criada.solicitacao.id), { decisoes: reprovarTudo(criada) });
      assert.deepEqual([segunda.status, segunda.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      assert.equal(await statusDe(criada), 'APROVADA');
      assert.equal((await auditorias('SOLICITACAO_EPI_DECIDIDA', criada.solicitacao.id)).length, 1);
    });

    test('corpo com decisor, resultado ou empresa (no corpo ou no item): 400 e nada muda', async () => {
      const criada = await criar(u.solicitante, await f.material());
      for (const corpo of [
        { decisoes: aprovarTudo(criada), decididaPor: u.sstB },
        { decisoes: aprovarTudo(criada), status: 'APROVADA' },
        { decisoes: aprovarTudo(criada), empresaId: d.empresaB },
        { decisoes: [{ ...aprovarTudo(criada)[0], previstoNoGhe: true }] },
        { decisoes: [] },
      ]) {
        const r = await como(u.decisor).post(decisao(criada.solicitacao.id), corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
      }
      assert.equal(await statusDe(criada), 'PENDENTE');
    });
  });

  describe('POST /solicitacoes-epi/:id/decisao — reprovação e decisão mista', () => {
    test('200 REPROVADA pelo usuário da sessão com REPROVAR_SOLICITACAO; a posição do par não muda', async () => {
      const m = await f.material();
      await f.estoque(m, 2);
      const criada = await criar(u.solicitante, m);
      const antes = f.numeros(await f.posicao(m));
      const r = await como(u.reprovador).post(decisao(criada.solicitacao.id), { decisoes: reprovarTudo(criada) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.solicitacao.status, r.body.solicitacao.decisao.decididaPor, r.body.itens[0].decisao], ['REPROVADA', u.reprovador, 'REPROVADO']);
      assert.deepEqual(f.numeros(await f.posicao(m)), antes);
    });

    test('sem REPROVAR_SOLICITACAO: quem só aprova não reprova (403 PERMISSAO_NEGADA); reprovar sem justificativa é 400', async () => {
      const criada = await criar(u.solicitante, await f.material());
      const r = await como(u.aprovador).post(decisao(criada.solicitacao.id), { decisoes: reprovarTudo(criada) });
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const semJustificativa = await como(u.reprovador).post(decisao(criada.solicitacao.id), { decisoes: [{ itemId: criada.itens[0].id, decisao: 'REPROVADO' }] });
      assert.deepEqual([semJustificativa.status, semJustificativa.body.codigo], [400, 'VALIDACAO']);
      assert.equal(await statusDe(criada), 'PENDENTE');
    });

    test('mista (um item aprovado e outro reprovado): só com uma das ações é 403; com as duas é 200 APROVADA_PARCIAL', async () => {
      const m = await f.material();
      const criada = await criar(u.solicitante, m, { outros: [{ materialId: d.capacete, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }] });
      const decisoes = [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }, { itemId: criada.itens[1].id, decisao: 'REPROVADO', justificativa: 'Já recebeu este mês' }];
      for (const usuario of [u.aprovador, u.reprovador]) {
        const r = await como(usuario).post(decisao(criada.solicitacao.id), { decisoes });
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], `usuário ${usuario}`);
      }
      assert.equal(await statusDe(criada), 'PENDENTE');
      const ambos = await como(u.decisor).post(decisao(criada.solicitacao.id), { decisoes });
      assert.equal(ambos.status, 200, JSON.stringify(ambos.body));
      assert.equal(ambos.body.solicitacao.status, 'APROVADA_PARCIAL');
    });

    test('outra empresa na reprovação: o mesmo 404 da inexistente', async () => {
      const daB = await criar(u.solicitanteB, d.botinaB, { empresaId: d.empresaB, funcionarioId: d.trabalhadorB });
      const inexistente = resposta(await como(u.reprovador).post(decisao(ID_INEXISTENTE), { decisoes: reprovarTudo(daB) }));
      const cruzada = resposta(await como(u.reprovador).post(decisao(daB.solicitacao.id), { decisoes: reprovarTudo(daB) }));
      assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzada, inexistente);
      assert.equal(await statusDe(daB), 'PENDENTE');
    });
  });

  describe('autodecisão x autoencerramento: quem criou não aprova nem reprova a própria, mas encerra a própria com autoridade válida', () => {
    test('aprovar a própria: 403 AUTODECISAO_PROIBIDA; reprovar a própria: 403 AUTODECISAO_PROIBIDA; continua PENDENTE', async () => {
      const propria = await criar(u.sstCompleto, await f.material());
      const aprovar = await como(u.sstCompleto).post(decisao(propria.solicitacao.id), { decisoes: aprovarTudo(propria) });
      assert.deepEqual([aprovar.status, aprovar.body.codigo], [403, 'AUTODECISAO_PROIBIDA']);
      const reprovar = await como(u.sstCompleto).post(decisao(propria.solicitacao.id), { decisoes: reprovarTudo(propria) });
      assert.deepEqual([reprovar.status, reprovar.body.codigo], [403, 'AUTODECISAO_PROIBIDA']);
      assert.equal(await statusDe(propria), 'PENDENTE');
      assert.deepEqual(await auditorias('SOLICITACAO_EPI_DECIDIDA', propria.solicitacao.id), []);
    });

    test('encerrar a própria, depois de aprovada por outro, com ENCERRAR_SOLICITACAO e vínculo SST: 200 ENCERRADA, auditada como autoencerramento', async () => {
      const propria = await aprovada(u.sstCompleto, await f.material());
      const r = await como(u.sstCompleto).post(encerramento(propria.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.solicitacao.status, r.body.solicitacao.encerramento.encerradaPor], ['ENCERRADA', u.sstCompleto]);
      const [registro] = await auditorias('SOLICITACAO_EPI_ENCERRADA', propria.solicitacao.id);
      assert.deepEqual([registro.usuario_id, registro.contexto.autoencerramento], [u.sstCompleto, true]);
    });
  });

  describe('POST /solicitacoes-epi/:id/encerramento', () => {
    test('APROVADA: 200 ENCERRADA pelo usuário da sessão; a justificativa fica gravada e volta no ato; o pendente sai da demanda; a auditoria não leva a justificativa', async () => {
      const m = await f.material();
      await f.estoque(m, 1);
      const alvo = await aprovada(u.solicitante, m, { quantidade: 3 });
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 3, 1, 0, 2]);
      const r = await como(u.encerrador).post(encerramento(alvo.solicitacao.id), { justificativa: `  ${JUSTIFICATIVA_ENCERRAMENTO}  ` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.solicitacao.status, r.body.solicitacao.encerramento.encerradaPor, r.body.solicitacao.encerramento.justificativa], ['ENCERRADA', u.encerrador, JUSTIFICATIVA_ENCERRAMENTO]);
      assert.deepEqual(r.body.itens.map((i) => [i.quantidadeEntregue, i.quantidadePendente]), [[0, 0]]);
      const gravada = await linha(alvo.solicitacao.id);
      assert.deepEqual([gravada.status, gravada.encerrada_por, gravada.justificativa_encerramento], ['ENCERRADA', u.encerrador, JUSTIFICATIVA_ENCERRAMENTO]);
      assert.deepEqual(f.numeros(await f.posicao(m)), [1, 0, 0, 1, 0]);
      const registros = await auditorias('SOLICITACAO_EPI_ENCERRADA', alvo.solicitacao.id);
      assert.equal(registros.length, 1);
      assert.deepEqual([registros[0].usuario_id, registros[0].descricao, registros[0].contexto.autoencerramento], [u.encerrador, null, false]);
      assert.equal(JSON.stringify(registros[0]).includes(JUSTIFICATIVA_ENCERRAMENTO), false, 'a justificativa não vai para a auditoria');
    });

    test('APROVADA_PARCIAL com entrega anterior: 200; a entrega, a ficha e o lote ficam como estavam; só o pendente é liberado', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 5);
      const criada = await criar(u.solicitante, m, { quantidade: 4 });
      await decidirPeloServico(criada, [{ itemId: criada.itens[0].id, decisao: 'APROVADO', quantidadeAprovada: 3, justificativa: 'Reposição parcial' }]);
      assert.equal(await statusDe(criada), 'APROVADA_PARCIAL');
      const entrega = await entregaSvc.registrarEntregaPorSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: criada.solicitacao.id, itens: [{ solicitacaoItemId: criada.itens[0].id, loteId, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
      });
      const fichaAntes = (await q('SELECT * FROM fichas_epi WHERE id = $1', [entrega.ficha.id])).rows[0];
      const entregaAntes = (await q('SELECT * FROM entregas_epi_itens WHERE entrega_id = $1 ORDER BY id', [entrega.entrega.id])).rows;
      const loteAntes = await f.lote(loteId);
      const r = await como(u.encerrador).post(encerramento(criada.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.itens.map((i) => [i.quantidadeAprovada, i.quantidadeEntregue, i.quantidadePendente]), [[3, 1, 0]]);
      assert.deepEqual((await q('SELECT * FROM fichas_epi WHERE id = $1', [entrega.ficha.id])).rows[0], fichaAntes);
      assert.deepEqual((await q('SELECT * FROM entregas_epi_itens WHERE entrega_id = $1 ORDER BY id', [entrega.entrega.id])).rows, entregaAntes);
      assert.deepEqual(await f.lote(loteId), loteAntes);
      assert.deepEqual(f.numeros(await f.posicao(m)), [4, 0, 0, 4, 0]);
      const [registro] = await auditorias('SOLICITACAO_EPI_ENCERRADA', criada.solicitacao.id);
      assert.deepEqual([registro.contexto.quantidadeEntregue, registro.contexto.quantidadeLiberada, registro.dados_anteriores.status], [1, 2, 'APROVADA_PARCIAL']);
    });

    test('justificativa obrigatória: ausente, nula, vazia, só com espaços ou longa demais é 400; continua APROVADA e nada é auditado', async () => {
      const alvo = await aprovada(u.solicitante, await f.material());
      for (const corpo of [{}, { justificativa: null }, { justificativa: '' }, { justificativa: '    ' }, { justificativa: '  ' }, { justificativa: 'x'.repeat(501) }]) {
        const r = await como(u.encerrador).post(encerramento(alvo.solicitacao.id), corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo).slice(0, 30));
      }
      const soEspacos = await como(u.encerrador).post(encerramento(alvo.solicitacao.id), { justificativa: '   ' });
      assert.ok(soEspacos.body.detalhes.some((x) => x.codigo === 'JUSTIFICATIVA_OBRIGATORIA'), JSON.stringify(soEspacos.body));
      assert.equal(await statusDe(alvo), 'APROVADA');
      assert.deepEqual(await auditorias('SOLICITACAO_EPI_ENCERRADA', alvo.solicitacao.id), []);
    });

    test('repetição e estado final: a segunda é 409 SOLICITACAO_NAO_ENCERRAVEL; a ENCERRADA não é cancelada, decidida nem entregue (409); uma auditoria só', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 2);
      const alvo = await aprovada(u.solicitante, m);
      assert.equal((await como(u.encerrador).post(encerramento(alvo.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO })).status, 200);
      const segunda = await como(u.encerrador).post(encerramento(alvo.solicitacao.id), { justificativa: 'Outra vez' });
      assert.deepEqual([segunda.status, segunda.body.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL']);
      const cancelar = await como(u.solicitante).post(`/api/solicitacoes-epi/${alvo.solicitacao.id}/cancelamento`, {});
      assert.deepEqual([cancelar.status, cancelar.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      const decidir = await como(u.decisor).post(decisao(alvo.solicitacao.id), { decisoes: aprovarTudo(alvo) });
      assert.deepEqual([decidir.status, decidir.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      const entregar = await como(d.master).post(`/api/solicitacoes-epi/${alvo.solicitacao.id}/entregas`, {
        itens: [{ solicitacaoItemId: alvo.itens[0].id, loteId, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
      });
      assert.deepEqual([entregar.status, entregar.body.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
      const gravada = await linha(alvo.solicitacao.id);
      assert.deepEqual([gravada.status, gravada.encerrada_por, gravada.justificativa_encerramento], ['ENCERRADA', u.encerrador, JUSTIFICATIVA_ENCERRAMENTO]);
      assert.equal((await auditorias('SOLICITACAO_EPI_ENCERRADA', alvo.solicitacao.id)).length, 1);
    });

    test('só APROVADA ou APROVADA_PARCIAL: PENDENTE, REPROVADA, CANCELADA e ENTREGUE são 409 SOLICITACAO_NAO_ENCERRAVEL', async () => {
      const pendente = await criar(u.solicitante, await f.material());
      const reprovada = await criar(u.solicitante, await f.material());
      await decidirPeloServico(reprovada, reprovarTudo(reprovada));
      const cancelada = await criar(u.solicitante, await f.material());
      await solicitacaoSvc.cancelarSolicitacao(pool, { empresaId: d.empresaA, atorId: u.solicitante, solicitacaoId: cancelada.solicitacao.id, hoje: f.HOJE });
      const m = await f.material();
      const loteId = await f.estoque(m, 2);
      const entregue = await aprovada(u.solicitante, m);
      await entregaSvc.registrarEntregaPorSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: entregue.solicitacao.id, itens: [{ solicitacaoItemId: entregue.itens[0].id, loteId, quantidade: 2 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
      });
      for (const [nome, alvo] of [['PENDENTE', pendente], ['REPROVADA', reprovada], ['CANCELADA', cancelada], ['ENTREGUE', entregue]]) {
        assert.equal(await statusDe(alvo), nome);
        const r = await como(u.encerrador).post(encerramento(alvo.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO });
        assert.deepEqual([r.status, r.body.codigo], [409, 'SOLICITACAO_NAO_ENCERRAVEL'], nome);
        assert.equal(await statusDe(alvo), nome);
      }
    });

    test('sem ENCERRAR_SOLICITACAO (SST que aprova e reprova), sem vínculo SST (só a autorização), sem nada e MASTER provisionado: o mesmo 403 PERMISSAO_NEGADA', async () => {
      const alvo = await aprovada(u.solicitante, await f.material());
      const respostas = [];
      for (const usuario of [u.sstSemEncerrar, u.encerradorSemVinculo, u.semNada, d.master]) {
        respostas.push(resposta(await como(usuario).post(encerramento(alvo.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO })));
      }
      assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
      for (const r of respostas) assert.deepEqual(r, respostas[0]);
      assert.equal(await statusDe(alvo), 'APROVADA');
    });

    test('autorização individual OBRIGATORIA: nem a concessão por perfil nem a de grupo substituem a individual (403); a individual concede', async (t) => {
      const alvo = await aprovada(u.solicitante, await f.material());
      const usuario = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', sst: true });
      const { id: grupoId } = await inserir(pool, 'grupos_acesso', { empresa_id: d.empresaA, nome: 'Grupo SST de teste', criado_por: d.master });
      await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [usuario, grupoId]);
      await inserir(pool, 'grupo_permissoes_acao', { empresa_id: d.empresaA, grupo_acesso_id: grupoId, acao_codigo: 'ENCERRAR_SOLICITACAO', permitido: true });
      await inserir(pool, 'permissoes_acao', { empresa_id: d.empresaA, perfil: 'ADMINISTRADOR', acao_codigo: 'ENCERRAR_SOLICITACAO', permitido: true });
      t.after(() => q("DELETE FROM permissoes_acao WHERE empresa_id = $1 AND perfil = 'ADMINISTRADOR' AND acao_codigo = 'ENCERRAR_SOLICITACAO'", [d.empresaA]));
      const negado = await como(usuario).post(encerramento(alvo.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO });
      assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.equal(await statusDe(alvo), 'APROVADA');
      await inserir(pool, 'usuario_autorizacoes', {
        usuario_id: usuario, empresa_id: d.empresaA, acao_codigo: 'ENCERRAR_SOLICITACAO', autorizado_por: d.master,
      });
      const concedido = await como(usuario).post(encerramento(alvo.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO });
      assert.equal(concedido.status, 200, JSON.stringify(concedido.body));
    });

    test('outra empresa: encerrar a da outra é o mesmo 404 da inexistente (corpo idêntico), nos dois sentidos; nada muda', async () => {
      const daA = await aprovada(u.solicitante, await f.material());
      const daB = await aprovada(u.solicitanteB, d.botinaB, { empresaId: d.empresaB, funcionarioId: d.trabalhadorB, decisor: d.sstB });
      const corpo = { justificativa: JUSTIFICATIVA_ENCERRAMENTO };
      const inexistente = resposta(await como(u.encerrador).post(encerramento(ID_INEXISTENTE), corpo));
      const cruzada = resposta(await como(u.encerrador).post(encerramento(daB.solicitacao.id), corpo));
      assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzada, inexistente);
      const inexistenteB = resposta(await como(u.sstB).post(encerramento(ID_INEXISTENTE), corpo));
      const cruzadaB = resposta(await como(u.sstB).post(encerramento(daA.solicitacao.id), corpo));
      assert.deepEqual([inexistenteB.status, inexistenteB.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzadaB, inexistenteB);
      assert.deepEqual([await statusDe(daA), await statusDe(daB)], ['APROVADA', 'APROVADA']);
    });

    test('corpo com encerrador, instante, status ou empresa: 400; nada muda', async () => {
      const alvo = await aprovada(u.solicitante, await f.material());
      for (const extra of [{ encerradaPor: u.sstB }, { encerradaEm: '2026-10-03T00:00:00Z' }, { status: 'ENCERRADA' }, { empresaId: d.empresaB }]) {
        const r = await como(u.encerrador).post(encerramento(alvo.solicitacao.id), { justificativa: JUSTIFICATIVA_ENCERRAMENTO, ...extra });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(extra));
      }
      assert.equal(await statusDe(alvo), 'APROVADA');
    });
  });
});
