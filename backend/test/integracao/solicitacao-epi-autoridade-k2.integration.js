'use strict';

const {
  describe, test, before, after,
} = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const {
  chaveNova, esperarHttpError, aguardarEsperaPorTravaDeLinha, comLimite,
} = require('./helpers/solicitacao-epi-servico');
const { criarSolicitacao: inserirSolicitacaoPorSql } = require('./helpers/solicitacao-epi');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const { avaliarPermissaoAcao } = require('../../src/middleware/autorizacao');

/**
 * K2 — autoridade de aprovar, reprovar e encerrar solicitações de EPI, contra PostgreSQL real, pela rota HTTP e DIRETAMENTE pelo
 * serviço (que passou a revalidá-la dentro da transação, com a política efetiva do middleware sobre o `client` do ato).
 *
 * Regras provadas: o MASTER nunca decide nem encerra, ainda que receba a linha de perfil, a concessão individual e o vínculo SST; quem
 * não é MASTER precisa do vínculo SST, da concessão de cada ação que o ato usa e de nenhum bloqueio individual; a decisão mista exige
 * as duas ações; a autodecisão continua proibida (e o autoencerramento, permitido); o pedido do Totem (origem AUTOATENDIMENTO, sem
 * solicitante) é decidido normalmente pela SST; a autoridade de uma empresa não vale na outra; e uma revogação CONFIRMADA antes da
 * avaliação transacional impede o ato. Nada aqui altera a política RBAC genérica.
 *
 * O pedido do Totem é criado no nível dos dados (origem AUTOATENDIMENTO, solicitante nulo), que é o que a autoridade enxerga; o
 * caminho completo do tablet até o pedido é provado nas suítes token-pedido e token-solicitacoes.
 */

const APROVAR = 'APROVAR_SOLICITACAO';
const REPROVAR = 'REPROVAR_SOLICITACAO';
const ENCERRAR = 'ENCERRAR_SOLICITACAO';
const TRES_ACOES = [APROVAR, REPROVAR, ENCERRAR];
const NEGADO = [403, 'PERMISSAO_NEGADA'];
const JUSTIFICATIVA = 'Sem necessidade comprovada';

describe('K2 — autoridade das solicitações de EPI, pela rota e pelo serviço (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  let usuarioCom;
  const u = {};

  const q = (sql, params) => pool.query(sql, params);
  const empresaDe = (usuarioId) => (usuarioId === d.sstB || usuarioId === u.sstB ? d.empresaB : d.empresaA);

  // ---- fixtures -------------------------------------------------------------------------------------------------------------------
  async function pendente({ origem = 'USUARIO_INTERNO', solicitante = d.solicitante, itens = 1 } = {}) {
    const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
    const materiais = [];
    for (let i = 0; i < itens; i += 1) materiais.push(await f.material());
    if (origem === 'AUTOATENDIMENTO') {
      const { solicitacao, itens: criados } = await inserirSolicitacaoPorSql(pool, d, {
        empresaId: d.empresaA,
        funcionarioId: trabalhador,
        origem,
        itens: materiais.map((m) => ({ empresa_id: d.empresaA, material_id: m, tamanho: '40', quantidade: 2 })),
      });
      return { id: solicitacao.id, itens: criados.map((i) => i.id) };
    }
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA,
      atorId: solicitante,
      funcionarioId: trabalhador,
      itens: materiais.map((m) => ({ materialId: m, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO' })),
      chaveIdempotencia: chaveNova(),
    });
    return { id: criada.solicitacao.id, itens: criada.itens.map((i) => i.id) };
  }

  // Solicitação APROVADA (decidida por um decisor autorizado dos fixtures), pronta para encerrar.
  async function aprovada(opcoes = {}) {
    const alvo = await pendente(opcoes);
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: u.sst, solicitacaoId: alvo.id, decisoes: alvo.itens.map((itemId) => ({ itemId, decisao: 'APROVADO' })), hoje: f.HOJE,
    });
    return alvo;
  }

  const aprovarItens = (alvo) => alvo.itens.map((itemId) => ({ itemId, decisao: 'APROVADO' }));
  const reprovarItens = (alvo) => alvo.itens.map((itemId) => ({ itemId, decisao: 'REPROVADO', justificativa: JUSTIFICATIVA }));
  const mista = (alvo) => [{ itemId: alvo.itens[0], decisao: 'APROVADO' }, { itemId: alvo.itens[1], decisao: 'REPROVADO', justificativa: JUSTIFICATIVA }];

  const decidirHttp = (usuarioId, alvo, decisoes) => como(usuarioId).post(`/api/solicitacoes-epi/${alvo.id}/decisao`, { decisoes });
  const encerrarHttp = (usuarioId, alvo) => como(usuarioId).post(`/api/solicitacoes-epi/${alvo.id}/encerramento`, { justificativa: 'Não será mais entregue' });
  const decidirSvc = (atorId, alvo, decisoes, empresaId = empresaDe(atorId)) => solicitacaoSvc.decidirSolicitacao(pool, {
    empresaId, atorId, solicitacaoId: alvo.id, decisoes, hoje: f.HOJE,
  });
  const encerrarSvc = (atorId, alvo, empresaId = empresaDe(atorId)) => solicitacaoSvc.encerrarSolicitacao(pool, {
    empresaId, atorId, solicitacaoId: alvo.id, justificativa: 'Não será mais entregue', hoje: f.HOJE,
  });
  const resposta = (r) => [r.status, r.body.codigo];

  const gravado = async (alvo) => (await q(
    'SELECT status, decidida_por, encerrada_por FROM solicitacoes_epi WHERE id = $1', [alvo.id],
  )).rows[0];
  const itensGravados = async (alvo) => (await q(
    'SELECT id, decisao, quantidade_aprovada FROM solicitacoes_epi_itens WHERE solicitacao_id = $1 ORDER BY id', [alvo.id],
  )).rows;
  const auditoriasDeDecisao = async () => (await q(
    "SELECT count(*)::int AS n FROM logs_auditoria WHERE acao IN ('SOLICITACAO_EPI_DECIDIDA', 'SOLICITACAO_EPI_ENCERRADA')",
  )).rows[0].n;
  // Tudo o que um ato de decisão ou de encerramento grava: o cabeçalho, os itens e a auditoria.
  const fotografia = async (alvo) => JSON.stringify([await gravado(alvo), await itensGravados(alvo), await auditoriasDeDecisao()]);

  async function usuarioDaSst(acoes = TRES_ACOES, empresaId = d.empresaA, extra = {}) {
    return usuarioCom(empresaId, {
      perfil: 'ADMINISTRADOR', acoes, sst: true, ...extra,
    });
  }

  before(async () => {
    env = await montarAmbiente12f();
    ({
      pool, d, f, como, usuarioCom,
    } = env);
    u.sst = await usuarioDaSst();
    u.sstB = await usuarioDaSst(TRES_ACOES, d.empresaB);
  });

  after(async () => { if (env) await env.encerrar(); });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('o MASTER nunca aprova, reprova nem encerra, mesmo com permissão atribuída indevidamente', () => {
    before(async () => {
      for (const acao of TRES_ACOES) {
        await q(
          `INSERT INTO permissoes_acao (empresa_id, perfil, acao_codigo, permitido) VALUES ($1, 'MASTER', $2, true)
           ON CONFLICT ON CONSTRAINT uq_permissoes_acao_empresa_perfil_acao DO UPDATE SET permitido = true`,
          [d.empresaA, acao],
        );
        await q('INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $2)', [d.empresaA, d.master, acao]);
      }
      await q('INSERT INTO vinculo_sst (empresa_id, usuario_id, concedido_por) VALUES ($1, $2, $2)', [d.empresaA, d.master]);
    });

    after(async () => {
      await q('DELETE FROM vinculo_sst WHERE usuario_id = $1', [d.master]);
      await q('DELETE FROM usuario_autorizacoes WHERE usuario_id = $1', [d.master]);
      await q("DELETE FROM permissoes_acao WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = ANY($2::text[])", [d.empresaA, TRES_ACOES]);
    });

    test('a política genérica deixaria o MASTER passar (é por isso que a rota o admite), e o serviço o nega nas três operações; nada é gravado nem auditado', async () => {
      for (const acao of TRES_ACOES) {
        assert.equal(await avaliarPermissaoAcao(pool, { empresaId: d.empresaA, usuarioId: d.master, perfil: 'MASTER' }, acao), true, `pré-condição: ${acao}`);
      }
      const paraAprovar = await pendente();
      const paraReprovar = await pendente();
      const paraEncerrar = await aprovada();
      const antes = [await fotografia(paraAprovar), await fotografia(paraReprovar), await fotografia(paraEncerrar)];

      // Pela rota: o middleware admite o MASTER, e quem nega é o serviço, com o mesmo 403 genérico.
      assert.deepEqual(resposta(await decidirHttp(d.master, paraAprovar, aprovarItens(paraAprovar))), NEGADO);
      assert.deepEqual(resposta(await decidirHttp(d.master, paraReprovar, reprovarItens(paraReprovar))), NEGADO);
      assert.deepEqual(resposta(await encerrarHttp(d.master, paraEncerrar)), NEGADO);
      // Diretamente pelo serviço.
      await esperarHttpError(decidirSvc(d.master, paraAprovar, aprovarItens(paraAprovar)), ...NEGADO);
      await esperarHttpError(decidirSvc(d.master, paraReprovar, reprovarItens(paraReprovar)), ...NEGADO);
      await esperarHttpError(encerrarSvc(d.master, paraEncerrar), ...NEGADO);

      assert.deepEqual([await fotografia(paraAprovar), await fotografia(paraReprovar), await fotografia(paraEncerrar)], antes);
    });

    test('a decisão mista também é negada ao MASTER, e o pedido do Totem também', async () => {
      const dois = await pendente({ itens: 2 });
      const doTotem = await pendente({ origem: 'AUTOATENDIMENTO' });
      const antes = [await fotografia(dois), await fotografia(doTotem)];
      assert.deepEqual(resposta(await decidirHttp(d.master, dois, mista(dois))), NEGADO);
      await esperarHttpError(decidirSvc(d.master, dois, mista(dois)), ...NEGADO);
      assert.deepEqual(resposta(await decidirHttp(d.master, doTotem, aprovarItens(doTotem))), NEGADO);
      await esperarHttpError(decidirSvc(d.master, doTotem, reprovarItens(doTotem)), ...NEGADO);
      assert.deepEqual([await fotografia(dois), await fotografia(doTotem)], antes);
    });

    test('quem criou a solicitação (MASTER) continua sem decidir a própria: a autodecisão é conferida ANTES', async () => {
      const propria = await pendente({ solicitante: d.master });
      await esperarHttpError(decidirSvc(d.master, propria, aprovarItens(propria)), 403, 'AUTODECISAO_PROIBIDA');
      await esperarHttpError(decidirSvc(d.master, propria, reprovarItens(propria)), 403, 'AUTODECISAO_PROIBIDA');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('a SST com vínculo, concessão efetiva e sem bloqueio decide e encerra', () => {
    test('pela rota: aprova, reprova e encerra; cada ato grava o decisor e audita uma vez', async () => {
      const alvoAprovar = await pendente();
      const alvoReprovar = await pendente();
      const alvoEncerrar = await aprovada();
      const auditoriasAntes = await auditoriasDeDecisao();

      const aprovou = await decidirHttp(u.sst, alvoAprovar, aprovarItens(alvoAprovar));
      assert.deepEqual([aprovou.status, aprovou.body.solicitacao.status], [200, 'APROVADA']);
      const reprovou = await decidirHttp(u.sst, alvoReprovar, reprovarItens(alvoReprovar));
      assert.deepEqual([reprovou.status, reprovou.body.solicitacao.status], [200, 'REPROVADA']);
      const encerrou = await encerrarHttp(u.sst, alvoEncerrar);
      assert.deepEqual([encerrou.status, encerrou.body.solicitacao.status], [200, 'ENCERRADA']);

      assert.deepEqual((await gravado(alvoAprovar)).decidida_por, u.sst);
      assert.deepEqual((await gravado(alvoEncerrar)).encerrada_por, u.sst);
      assert.equal(await auditoriasDeDecisao(), auditoriasAntes + 3);
    });

    test('diretamente pelo serviço: o mesmo ator autorizado decide e encerra', async () => {
      const alvo = await pendente();
      assert.equal((await decidirSvc(u.sst, alvo, aprovarItens(alvo))).solicitacao.status, 'APROVADA');
      assert.equal((await encerrarSvc(u.sst, alvo)).solicitacao.status, 'ENCERRADA');
    });

    test('a decisão mista exige as DUAS ações: com as duas, APROVADA_PARCIAL; só com APROVAR ou só com REPROVAR, 403 pela rota e pelo serviço, sem gravar', async () => {
      const comAsDuas = await pendente({ itens: 2 });
      const resultado = await decidirHttp(u.sst, comAsDuas, mista(comAsDuas));
      assert.deepEqual([resultado.status, resultado.body.solicitacao.status], [200, 'APROVADA_PARCIAL']);

      for (const concedida of [APROVAR, REPROVAR]) {
        const usuario = await usuarioDaSst([concedida]);
        const alvo = await pendente({ itens: 2 });
        const antes = await fotografia(alvo);
        assert.deepEqual(resposta(await decidirHttp(usuario, alvo, mista(alvo))), NEGADO, `só com ${concedida}: rota`);
        await esperarHttpError(decidirSvc(usuario, alvo, mista(alvo)), ...NEGADO);
        assert.equal(await fotografia(alvo), antes, `só com ${concedida}: nada gravado`);
      }
    });

    test('a ação exigida é a do que a decisão faz: só APROVAR aprova (e não reprova), só REPROVAR reprova (e não aprova), e nenhuma das duas encerra', async () => {
      const soAprovar = await usuarioDaSst([APROVAR]);
      const soReprovar = await usuarioDaSst([REPROVAR]);
      const alvoA = await pendente();
      const alvoR = await pendente();
      assert.equal((await decidirSvc(soAprovar, alvoA, aprovarItens(alvoA))).solicitacao.status, 'APROVADA');
      assert.equal((await decidirSvc(soReprovar, alvoR, reprovarItens(alvoR))).solicitacao.status, 'REPROVADA');

      const naoDecide = await pendente();
      await esperarHttpError(decidirSvc(soAprovar, naoDecide, reprovarItens(naoDecide)), ...NEGADO);
      await esperarHttpError(decidirSvc(soReprovar, naoDecide, aprovarItens(naoDecide)), ...NEGADO);
      const paraEncerrar = await aprovada();
      await esperarHttpError(encerrarSvc(soAprovar, paraEncerrar), ...NEGADO);
      await esperarHttpError(encerrarSvc(soReprovar, paraEncerrar), ...NEGADO);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('sem a autoridade completa, o serviço nega (e a rota também): é o mesmo 403 PERMISSAO_NEGADA, sem gravar', () => {
    const operacoes = {
      aprovar: { preparar: pendente, http: (usuario, alvo) => decidirHttp(usuario, alvo, aprovarItens(alvo)), svc: (usuario, alvo) => decidirSvc(usuario, alvo, aprovarItens(alvo)), acoes: [APROVAR] },
      reprovar: { preparar: pendente, http: (usuario, alvo) => decidirHttp(usuario, alvo, reprovarItens(alvo)), svc: (usuario, alvo) => decidirSvc(usuario, alvo, reprovarItens(alvo)), acoes: [REPROVAR] },
      encerrar: { preparar: aprovada, http: (usuario, alvo) => encerrarHttp(usuario, alvo), svc: (usuario, alvo) => encerrarSvc(usuario, alvo), acoes: [ENCERRAR] },
    };

    async function esperarNegadoPorRotaEServico(usuario, operacao, rotulo) {
      const alvo = await operacao.preparar();
      const antes = await fotografia(alvo);
      assert.deepEqual(resposta(await operacao.http(usuario, alvo)), NEGADO, `${rotulo}: rota`);
      await esperarHttpError(operacao.svc(usuario, alvo), ...NEGADO);
      assert.equal(await fotografia(alvo), antes, `${rotulo}: nada gravado`);
    }

    for (const [nome, operacao] of Object.entries(operacoes)) {
      test(`${nome}: SST sem vínculo (mesmo com a concessão)`, async () => {
        await esperarNegadoPorRotaEServico(await usuarioDaSst(TRES_ACOES, d.empresaA, { sst: false }), operacao, nome);
      });

      test(`${nome}: SST sem a concessão da ação (mesmo com o vínculo e com as outras duas ações)`, async () => {
        const usuario = await usuarioDaSst(TRES_ACOES.filter((a) => !operacao.acoes.includes(a)));
        await esperarNegadoPorRotaEServico(usuario, operacao, nome);
      });

      test(`${nome}: bloqueio individual da ação prevalece sobre o vínculo e a concessão`, async () => {
        const usuario = await usuarioDaSst();
        await q('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [usuario, operacao.acoes[0], d.master]);
        await esperarNegadoPorRotaEServico(usuario, operacao, nome);
      });
    }

    test('perfil sozinho não decide: ADMINISTRADOR, SUPERVISOR e USUARIO sem vínculo nem concessão são negados pelo serviço nas três operações', async () => {
      for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
        const usuario = await usuarioCom(d.empresaA, { perfil });
        for (const [nome, operacao] of Object.entries(operacoes)) {
          const alvo = await operacao.preparar();
          const antes = await fotografia(alvo);
          await esperarHttpError(operacao.svc(usuario, alvo), ...NEGADO);
          assert.equal(await fotografia(alvo), antes, `${perfil} ${nome}`);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('separação de funções e pedido do Totem', () => {
    test('quem criou a solicitação, mesmo com toda a autoridade, não aprova nem reprova a própria (403 AUTODECISAO_PROIBIDA) e não é confundido com falta de permissão', async () => {
      const solicitante = await usuarioDaSst();
      const propria = await pendente({ solicitante });
      const antes = await fotografia(propria);
      for (const decisoes of [aprovarItens(propria), reprovarItens(propria)]) {
        const r = await decidirHttp(solicitante, propria, decisoes);
        assert.deepEqual(resposta(r), [403, 'AUTODECISAO_PROIBIDA']);
        await esperarHttpError(decidirSvc(solicitante, propria, decisoes), 403, 'AUTODECISAO_PROIBIDA');
      }
      assert.equal(await fotografia(propria), antes);
    });

    test('o autoencerramento continua permitido a quem tem a autoridade de encerrar', async () => {
      const solicitante = await usuarioDaSst();
      const propria = await pendente({ solicitante });
      await decidirSvc(u.sst, propria, aprovarItens(propria));
      const r = await encerrarHttp(solicitante, propria);
      assert.deepEqual([r.status, r.body.solicitacao.status], [200, 'ENCERRADA']);
    });

    test('o pedido do Totem (origem AUTOATENDIMENTO, sem solicitante) é aprovado, reprovado e encerrado normalmente pela SST autorizada', async () => {
      const paraAprovar = await pendente({ origem: 'AUTOATENDIMENTO' });
      const paraReprovar = await pendente({ origem: 'AUTOATENDIMENTO' });
      const paraEncerrar = await pendente({ origem: 'AUTOATENDIMENTO' });
      assert.equal((await q('SELECT origem_solicitacao, solicitante_usuario_id FROM solicitacoes_epi WHERE id = $1', [paraAprovar.id])).rows[0].solicitante_usuario_id, null);

      const aprovou = await decidirHttp(u.sst, paraAprovar, aprovarItens(paraAprovar));
      assert.deepEqual([aprovou.status, aprovou.body.solicitacao.status], [200, 'APROVADA']);
      const reprovou = await decidirHttp(u.sst, paraReprovar, reprovarItens(paraReprovar));
      assert.deepEqual([reprovou.status, reprovou.body.solicitacao.status], [200, 'REPROVADA']);
      await decidirSvc(u.sst, paraEncerrar, aprovarItens(paraEncerrar));
      assert.equal((await encerrarSvc(u.sst, paraEncerrar)).solicitacao.status, 'ENCERRADA');
    });

    test('o pedido do Totem não ganha autoridade nova: sem vínculo ou sem concessão a decisão segue negada', async () => {
      const alvo = await pendente({ origem: 'AUTOATENDIMENTO' });
      const antes = await fotografia(alvo);
      await esperarHttpError(decidirSvc(await usuarioDaSst(TRES_ACOES, d.empresaA, { sst: false }), alvo, aprovarItens(alvo)), ...NEGADO);
      await esperarHttpError(decidirSvc(await usuarioDaSst([]), alvo, reprovarItens(alvo)), ...NEGADO);
      assert.equal(await fotografia(alvo), antes);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('isolamento por empresa', () => {
    test('a SST da empresa B não decide nem encerra solicitação da empresa A: o mesmo 404 da inexistente, sem gravar', async () => {
      const alvo = await pendente();
      const aprovadaA = await aprovada();
      const antes = [await fotografia(alvo), await fotografia(aprovadaA)];
      const r = await decidirHttp(u.sstB, alvo, aprovarItens(alvo));
      assert.deepEqual(resposta(r), [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(resposta(await encerrarHttp(u.sstB, aprovadaA)), [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      await esperarHttpError(decidirSvc(u.sstB, alvo, aprovarItens(alvo), d.empresaB), 404, 'SOLICITACAO_NAO_ENCONTRADA');
      assert.deepEqual([await fotografia(alvo), await fotografia(aprovadaA)], antes);
    });

    test('a autoridade da empresa A não vale na B: o ator da A, usado com a empresa B, é "não encontrado", e a solicitação da B não muda', async () => {
      const { solicitacao, itens } = await inserirSolicitacaoPorSql(pool, d, {
        empresaId: d.empresaB,
        funcionarioId: d.trabalhadorB,
        solicitanteId: d.usuarioB,
        itens: [{ empresa_id: d.empresaB, material_id: d.botinaB, tamanho: '40', quantidade: 1 }],
      });
      const daB = { id: solicitacao.id, itens: itens.map((i) => i.id) };
      const antes = (await q('SELECT status, decidida_por FROM solicitacoes_epi WHERE id = $1', [daB.id])).rows[0];
      await esperarHttpError(decidirSvc(u.sst, daB, reprovarItens(daB), d.empresaB), 404, 'USUARIO_NAO_ENCONTRADO');
      assert.deepEqual((await q('SELECT status, decidida_por FROM solicitacoes_epi WHERE id = $1', [daB.id])).rows[0], antes);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------------------
  describe('revogação confirmada ANTES da avaliação transacional impede o ato', () => {
    // O ato espera a trava da solicitação (que o teste segura); a autoridade é revogada e CONFIRMADA nesse intervalo; só então a trava
    // é solta. A rota já teria autorizado: a revalidação do serviço, depois da trava e dentro da transação, é quem decide.
    async function revogandoDuranteATrava({ alvo, executar, revogar }) {
      const bloqueador = await pool.connect();
      try {
        await bloqueador.query('BEGIN');
        await bloqueador.query('SELECT 1 FROM solicitacoes_epi WHERE empresa_id = $1 AND id = $2 FOR UPDATE', [d.empresaA, alvo.id]);
        const execucao = executar().then(() => null, (erro) => erro);
        await comLimite(aguardarEsperaPorTravaDeLinha(pool), 'espera pela trava da solicitação');
        await revogar();
        await bloqueador.query('COMMIT');
        return await comLimite(execucao, 'ato após a revogação', 8000);
      } finally {
        await bloqueador.query('ROLLBACK').catch(() => {});
        bloqueador.release();
      }
    }

    const revogacoes = {
      'o vínculo SST': (usuario) => () => q('DELETE FROM vinculo_sst WHERE usuario_id = $1', [usuario]),
      'a concessão da ação': (usuario, acao) => () => q('DELETE FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = $2', [usuario, acao]),
      'um bloqueio individual novo': (usuario, acao) => () => q('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [usuario, acao, d.master]),
    };

    for (const [rotulo, revogar] of Object.entries(revogacoes)) {
      test(`revogar ${rotulo} enquanto a decisão espera a trava: 403 PERMISSAO_NEGADA e nada é gravado`, async () => {
        const usuario = await usuarioDaSst();
        const alvo = await pendente();
        const antes = await fotografia(alvo);
        const erro = await revogandoDuranteATrava({
          alvo, executar: () => decidirSvc(usuario, alvo, aprovarItens(alvo)), revogar: revogar(usuario, APROVAR),
        });
        assert.ok(erro, 'o ato deveria ter sido negado');
        assert.deepEqual([erro.status, erro.codigo], NEGADO);
        assert.equal(await fotografia(alvo), antes);
      });

      test(`revogar ${rotulo} enquanto o encerramento espera a trava: 403 PERMISSAO_NEGADA e nada é gravado`, async () => {
        const usuario = await usuarioDaSst();
        const alvo = await aprovada();
        const antes = await fotografia(alvo);
        const erro = await revogandoDuranteATrava({
          alvo, executar: () => encerrarSvc(usuario, alvo), revogar: revogar(usuario, ENCERRAR),
        });
        assert.ok(erro, 'o ato deveria ter sido negado');
        assert.deepEqual([erro.status, erro.codigo], NEGADO);
        assert.equal(await fotografia(alvo), antes);
      });
    }

    test('controle: esperar a trava sem revogar nada não nega; a autoridade vigente no momento da avaliação é a que vale', async () => {
      const usuario = await usuarioDaSst();
      const alvo = await pendente();
      const erro = await revogandoDuranteATrava({
        alvo, executar: () => decidirSvc(usuario, alvo, aprovarItens(alvo)), revogar: async () => {},
      });
      assert.equal(erro, null);
      assert.equal((await gravado(alvo)).status, 'APROVADA');
    });
  });
});
