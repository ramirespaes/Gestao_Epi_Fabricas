'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { ATENDIMENTO_INVALIDO, COOKIE_ATENDIMENTO, cabecalhoCookie, cookieDoAtendimentoNaResposta } = require('./helpers/token-atendimento');
const { PEDIDO, CHAVES_DO_PEDIDO, CHAVES_DO_ITEM, abrirAmbientePedido } = require('./helpers/token-pedido');
const { lerSetCookie, cookieDoTabletNaResposta, ORIGEM, IP_TESTE, sha256 } = require('./helpers/token-tablet');
const { criarLote, transacao } = require('./helpers/entrega-epi');
const { hashTokenSessao } = require('../../src/security/token');
const tokenTabletService = require('../../src/services/token-tablet.service');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const solicitacaoRepo = require('../../src/repositories/solicitacao-epi.repository');
const itemRepo = require('../../src/repositories/solicitacao-epi-item.repository');
const numeracaoRepo = require('../../src/repositories/solicitacao-epi-numeracao.repository');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const { dataOperacional } = require('../../src/utils/data-operacional');
const consultaSvc = require('../../src/services/solicitacao-epi-consulta.service');

// Contrato consumido pelo Totem: `pedido.numero` é o INTEGER de solicitacoes_epi (CHECK numero > 0), devolvido como inteiro JSON, nunca como texto.
const numeroDoPedidoValido = (n) => Number.isInteger(n) && n >= 1 && n <= 2147483647;

/**
 * Atendimento Token — Etapa F (RED): do carrinho finalizado ao PEDIDO (solicitação de EPI AUTOATENDIMENTO) pelo fluxo REAL da 12G-6.
 * PostgreSQL real, schema temporário com TODAS as migrations; sem migration nova. Reutiliza: tablet (C), atendimento (D), catálogo (E) e as
 * estruturas de solicitação (065/066/068/086): `solicitacoes_epi` (origem AUTOATENDIMENTO, sem solicitante), `solicitacoes_epi_itens`,
 * `solicitacoes_autoatendimento` (tablet + atendimento + cópia da localização), `solicitacoes_epi_numeracao`, chave de idempotência UUID
 * (UNIQUE empresa+chave), advisory lock da chave e o encerramento PEDIDO_ENVIADO da 086. Estados reais: PENDENTE → APROVADA | APROVADA_PARCIAL
 * | REPROVADA | CANCELADA → ENTREGUE | ENCERRADA; situação derivada AGUARDANDO_ESTOQUE → PRONTA_PARA_ENTREGA… (nada gravado).
 *
 * FRONTEIRA TRANSACIONAL proposta: requisição recebida (HTTP) → corpo validado → tablet autenticado → [BEGIN] lock da chave → repetição? (devolve o
 * resultado original) → lock do tablet + credencial reconferida → atendimento FOR UPDATE: vigente (relógio do banco), funcionário ATIVO, não anterior à
 * reativação (= PEDIDO ACEITO: depois deste ponto a expiração do relógio não o cancela) → materiais/GHE/tamanhos revalidados no estado ATUAL → número +
 * cabeçalho + itens + lateral AUTOATENDIMENTO + auditoria + atendimento encerrado PEDIDO_ENVIADO → [COMMIT = PERSISTIDO] → 201 (confirmação ao tablet).
 * Aceitação e persistência são UMA transação: não existe "aceito e não gravado". Pedido recebido com atendimento expirado/inválido é recusado ANTES da aceitação.
 *
 * TODOS os testes F1–F36 falham hoje PRIMEIRO pela ausência da rota (404 ROTA_NAO_ENCONTRADA na primeira asserção); as asserções internas só
 * serão verificadas no GREEN F (a coerência delas foi validada à parte contra um oráculo em memória). Os controles K passam já.
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];
const LIMITE_DE_SEGURANCA_MS = 10000;
const NAO_AUTORIZADO_ITEM = [409, 'ITEM_NAO_AUTORIZADO'];

describe('Atendimento Token — F: pedido do tablet pelo fluxo de solicitações da 12G-6 (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbientePedido();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const A = () => a.d.empresaA;
  const forcarRestante = (id, segundos) => a.q(`UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() + make_interval(secs => $2::int) WHERE id = $1`, [id, segundos]);
  const gerarCodigo = async (tabletId) => (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${tabletId}/ativacao`)).body.ativacao.codigo;
  const esperando = async (pid) => (await a.q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].n;

  /** Cenário padrão: GHE, funcionário e atendimento; devolve também materiais autorizados (grade P/M/G, único e do tipo ativo). */
  async function montar({ funcionario = {} } = {}) {
    const ghe = await a.ghe(A());
    const comGrade = await a.material(A(), { nome: 'F Botina', exigeTamanho: true, grade: ['P', 'M', 'G'] });
    const unico = await a.material(A(), { nome: 'F Protetor', exigeTamanho: false });
    const tipo = await a.tipo(A());
    const porTipo = await a.material(A(), { nome: 'F Luva do tipo', tipoLinha: tipo, exigeTamanho: false });
    await a.vincularMaterial(A(), ghe, comGrade); await a.vincularMaterial(A(), ghe, unico); await a.vincularTipo(A(), ghe, tipo.id);
    const c = await a.cenario(app, { gheId: ghe, funcionario });
    return { ghe, comGrade, unico, porTipo, tipo, ...c };
  }
  const enviar = (c, itens, extra = {}, aplicacao = app) => a.finalizar(aplicacao, c.t, c.token, a.corpo(itens, extra));
  const atendimentoDe = (c) => a.atendimento(c.atendimentoId);

  /** Uma recusa por regra de negócio deixa tudo como estava: nenhuma solicitação, número intacto, estoque/ficha/entrega intactos, atendimento ainda aberto. */
  async function exigirNadaCriado(c, antes, rotulo = '') {
    assert.deepEqual(await a.fotografia(), antes, `${rotulo}: nada foi criado nem alterado`);
    const linha = await atendimentoDe(c);
    assert.notEqual(linha.motivo_encerramento, 'PEDIDO_ENVIADO', `${rotulo}: o atendimento não pode constar como pedido enviado`);
  }

  // ───────────── controles do ambiente e do fluxo EXISTENTE da 12G-6 (passam já no RED) ─────────────
  describe('controles (devem passar já no RED)', () => {
    test('K1 — o fluxo existente de solicitações aceita material autorizado SEM estoque e é idempotente: mesma chave e mesmo corpo devolvem a original; mesma chave com outro corpo é IDEMPOTENCIA_CONFLITO (base reutilizada pela Etapa F)', async () => {
      const ghe = await a.ghe(A()); const m = await a.material(A(), { nome: 'K1 sem estoque' }); await a.vincularMaterial(A(), ghe, m);
      const f = await a.funcionarioNoGhe(A(), ghe);
      const chave = a.chave();
      const dados = { empresaId: A(), atorId: a.d.master, funcionarioId: f.id, itens: [{ materialId: m, quantidade: 2, motivo: 'ADMISSAO' }], chaveIdempotencia: chave };
      const primeira = await solicitacaoSvc.criarSolicitacao(a.ctx.pool, dados);
      assert.deepEqual([primeira.repetida, primeira.solicitacao.status, primeira.solicitacao.origemSolicitacao], [false, 'PENDENTE', 'USUARIO_INTERNO']);
      const segunda = await solicitacaoSvc.criarSolicitacao(a.ctx.pool, dados);
      assert.deepEqual([segunda.repetida, segunda.solicitacao.id], [true, primeira.solicitacao.id]);
      await assert.rejects(() => solicitacaoSvc.criarSolicitacao(a.ctx.pool, { ...dados, itens: [{ materialId: m, quantidade: 3, motivo: 'ADMISSAO' }] }), (e) => e.codigo === 'IDEMPOTENCIA_CONFLITO');
    });

    /** Persistência AUTOATENDIMENTO pelas peças reais (repositórios + lateral da 086 + encerramento PEDIDO_ENVIADO), numa transação. */
    async function persistirAutoatendimento(c, itens) {
      const chave = a.chave();
      const t = (await a.q('SELECT unidade, setor, local_instalacao FROM token_dispositivos WHERE id = $1', [c.t.id])).rows[0];
      return transacao(a.ctx.pool, async (cl) => {
        const sol = await solicitacaoRepo.criar(cl, {
          empresaId: A(), numero: await numeracaoRepo.proximoNumero(cl, A()), funcionarioId: c.f.id, gheId: c.gheId, origemSolicitacao: 'AUTOATENDIMENTO',
          solicitanteUsuarioId: null, quantidadeItens: itens.length, chave, requisicaoHash: sha256(chave),
        });
        const gravados = [];
        for (const i of itens) gravados.push(await itemRepo.criar(cl, { empresaId: A(), solicitacaoId: sol.id, previstoNoGhe: true, motivo: 'ADMISSAO', ...i }));
        await cl.query(
          'INSERT INTO solicitacoes_autoatendimento (solicitacao_id, empresa_id, dispositivo_id, atendimento_id, unidade, setor, local_instalacao) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [sol.id, A(), c.t.id, c.atendimentoId, t.unidade, t.setor, t.local_instalacao],
        );
        await cl.query("UPDATE token_atendimentos SET encerrado_em = clock_timestamp(), motivo_encerramento = 'PEDIDO_ENVIADO' WHERE id = $1 AND encerrado_em IS NULL", [c.atendimentoId]);
        return { sol, gravados };
      });
    }

    test('K2 — a ESTRUTURA já comporta o pedido do tablet: cabeçalho AUTOATENDIMENTO sem solicitante + itens + lateral (tablet, atendimento, localização) + atendimento PEDIDO_ENVIADO gravam e confirmam no COMMIT; o banco recusa lateral de atendimento de OUTRO funcionário e solicitante interno na origem AUTOATENDIMENTO', async () => {
      const c = await montar();
      const { sol } = await persistirAutoatendimento(c, [{ materialId: c.unico, quantidade: 1 }]);
      assert.deepEqual([sol.origemSolicitacao, sol.solicitanteUsuarioId, sol.status], ['AUTOATENDIMENTO', null, 'PENDENTE']);
      const lateral = await a.lateralDe(sol.id);
      assert.deepEqual([lateral.dispositivo_id, lateral.atendimento_id, lateral.setor], [c.t.id, String(c.atendimentoId), 'Expedição']);
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'PEDIDO_ENVIADO');
      const outro = await montar();
      await assert.rejects(() => transacao(a.ctx.pool, async (cl) => {
        const chave = a.chave();
        const s2 = await solicitacaoRepo.criar(cl, { empresaId: A(), numero: await numeracaoRepo.proximoNumero(cl, A()), funcionarioId: outro.f.id, gheId: outro.gheId, origemSolicitacao: 'AUTOATENDIMENTO', quantidadeItens: 1, chave, requisicaoHash: sha256(chave) });
        await itemRepo.criar(cl, { empresaId: A(), solicitacaoId: s2.id, materialId: outro.unico, quantidade: 1, motivo: 'ADMISSAO', previstoNoGhe: true });
        await cl.query('INSERT INTO solicitacoes_autoatendimento (solicitacao_id, empresa_id, dispositivo_id, atendimento_id) VALUES ($1, $2, $3, $4)', [s2.id, A(), c.t.id, c.atendimentoId]);
      }), /outro funcionário|atendimento/i, 'lateral com atendimento de outro funcionário');
    });

    test('K3 — a Segurança do Trabalho (serviço REAL de decisão) aprova o pedido AUTOATENDIMENTO SEM estoque: APROVADA, situação derivada AGUARDANDO_ESTOQUE, nada reservado nem baixado (pontos 2 e 3 da regra principal)', async () => {
      const c = await montar();
      const { sol, gravados } = await persistirAutoatendimento(c, [{ materialId: c.unico, quantidade: 2 }]);
      const fila = await consultaSvc.listarFila(a.ctx.pool, { empresaId: A(), pagina: 1, limite: 100 });
      assert.equal(JSON.stringify(fila).includes(`"numero":${sol.numero}`), true, 'a fila da SST enxerga o pedido AUTOATENDIMENTO');
      const antes = await a.fotografia();
      const dec = await solicitacaoSvc.decidirSolicitacao(a.ctx.pool, { empresaId: A(), atorId: a.d.sst1, solicitacaoId: sol.id, decisoes: [{ itemId: gravados[0].id, decisao: 'APROVADO' }] });
      assert.equal(dec.solicitacao.status, 'APROVADA');
      const visao = await solicitacaoSvc.buscarSolicitacao(a.ctx.pool, { empresaId: A(), solicitacaoId: sol.id });
      assert.equal(visao.itens[0].situacao, 'AGUARDANDO_ESTOQUE');
      const depois = await a.fotografia();
      assert.deepEqual([depois.lotesBaixado, depois.lotesEntregue, depois.operacoes, depois.entregas, depois.fichas], [antes.lotesBaixado, antes.lotesEntregue, antes.operacoes, antes.entregas, antes.fichas]);
    });

    test('K4 — a reposição é reconhecida pelo serviço real (derivada, sem gravar): após a entrada de estoque do material e tamanho a situação do item vira PRONTA_PARA_ENTREGA; a baixa e a ficha só existem na entrega (ponto 4 e 5)', async () => {
      const c = await montar();
      const { sol, gravados } = await persistirAutoatendimento(c, [{ materialId: c.comGrade, tamanho: 'M', quantidade: 1 }]);
      const antes = await a.fotografia();
      await solicitacaoSvc.decidirSolicitacao(a.ctx.pool, { empresaId: A(), atorId: a.d.sst1, solicitacaoId: sol.id, decisoes: [{ itemId: gravados[0].id, decisao: 'APROVADO' }] });
      assert.equal((await solicitacaoSvc.buscarSolicitacao(a.ctx.pool, { empresaId: A(), solicitacaoId: sol.id })).itens[0].situacao, 'AGUARDANDO_ESTOQUE');
      await criarLote(a.ctx.pool, { empresaId: A(), materialId: c.comGrade, quantidade: 5, tamanho: 'M' });
      assert.equal((await solicitacaoSvc.buscarSolicitacao(a.ctx.pool, { empresaId: A(), solicitacaoId: sol.id })).itens[0].situacao, 'PRONTA_PARA_ENTREGA');
      const f = await a.fotografia();
      assert.deepEqual([f.lotesBaixado, f.lotesEntregue, f.entregas, f.fichas], [antes.lotesBaixado, antes.lotesEntregue, antes.entregas, antes.fichas], 'sem entrega: nada baixado nem na ficha');
      const posicoes = await coberturaRepo.lerPosicoes(a.ctx.pool, A(), [{ materialId: c.comGrade, tamanho: 'M' }], { hoje: dataOperacional() });
      assert.equal(posicoes[0].fisicoUtilizavel, 5);
    });

    test('K5 — o catálogo congelado da Etapa E oferece ao tablet exatamente os materiais autorizados que o pedido da F deve aceitar (base do "carrinho só com material do catálogo")', async () => {
      const c = await montar();
      const r = await a.catalogo(app, c.t, c.token);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(r.body.catalogo.materiais.map((m) => m.id).sort((x, y) => x - y), [c.comGrade, c.unico, c.porTipo].sort((x, y) => x - y));
    });
  });

  // ───────────────────────── seleção, validação e quantidades ─────────────────────────
  describe('materiais, tamanhos e quantidades', () => {
    test('F1 — material físico autorizado pelo GHE: 201, pedido PENDENTE de origem AUTOATENDIMENTO (sem solicitante) para o funcionário DO ATENDIMENTO, com GHE atual, item previsto no GHE, lateral do tablet e atendimento encerrado PEDIDO_ENVIADO; resposta mínima (número, status, itens) e cookie removido', async () => {
      const c = await montar();
      const chave = a.chave();
      const r = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: chave, itens: [a.item(c.unico, { quantidade: 2, motivo: 'SUBSTITUICAO_PRAZO' })] });
      assert.equal(r.status, 201, aviso(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['pedido', 'repetida', 'status']);
      assert.equal(r.body.repetida, false);
      assert.equal(numeroDoPedidoValido(r.body.pedido.numero), true, 'pedido.numero é inteiro de 1 a 2147483647, não texto');
      assert.deepEqual(Object.keys(r.body.pedido).sort(), CHAVES_DO_PEDIDO);
      assert.deepEqual(r.body.pedido.itens.map((i) => Object.keys(i).sort()), [CHAVES_DO_ITEM]);
      assert.deepEqual([r.body.pedido.status, r.body.pedido.quantidadeItens, r.body.pedido.itens[0]], ['PENDENTE', 1, { materialId: c.unico, tamanho: null, quantidade: 2, motivo: 'SUBSTITUICAO_PRAZO' }]);
      const [sol] = await a.solicitacoesDe(c.f.id);
      assert.deepEqual([sol.origem_solicitacao, sol.solicitante_usuario_id, sol.status, sol.ghe_id, sol.numero, sol.chave_idempotencia], ['AUTOATENDIMENTO', null, 'PENDENTE', c.gheId, r.body.pedido.numero, chave]);
      const [it] = await a.itensDe(sol.id);
      assert.deepEqual([it.material_id, it.tamanho, it.quantidade, it.motivo, it.previsto_no_ghe, it.decisao], [c.unico, null, 2, 'SUBSTITUICAO_PRAZO', true, null]);
      const lateral = await a.lateralDe(sol.id);
      assert.deepEqual([lateral.empresa_id, lateral.dispositivo_id, lateral.atendimento_id, lateral.setor], [A(), c.t.id, String(c.atendimentoId), 'Expedição']);
      const fim = await atendimentoDe(c);
      assert.equal(fim.motivo_encerramento, 'PEDIDO_ENVIADO');
      assert.ok(lerSetCookie(r).some((x) => x.nome === COOKIE_ATENDIMENTO && x.atributos['max-age'] === '0'), 'o cookie do atendimento é descartado no sucesso');
    });

    test('F2 — material NÃO autorizado pelo GHE (existente, ativo, de outro GHE ou sem vínculo) é recusado com 409 ITEM_NAO_AUTORIZADO no caminho do item, e nada é criado', async () => {
      const c = await montar();
      const outroGhe = await a.ghe(A());
      const deOutroGhe = await a.material(A(), { nome: 'F2 de outro GHE' }); await a.vincularMaterial(A(), outroGhe, deOutroGhe);
      const solto = await a.material(A(), { nome: 'F2 solto' });
      const antes = await a.fotografia();
      for (const m of [deOutroGhe, solto]) {
        const r = await enviar(c, [a.item(c.unico), a.item(m)]);
        assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO_ITEM, aviso(r));
        assert.equal(r.body.detalhes[0].campo, 'body.itens[1].materialId');
      }
      await exigirNadaCriado(c, antes, 'F2');
    });

    test('F3 — material INATIVO é recusado como não autorizado (mesmo código, sem revelar o motivo), direto ou por tipo', async () => {
      const c = await montar();
      const t = await a.tipo(A());
      const inativo = await a.material(A(), { nome: 'F3 inativo direto', ativo: false }); await a.vincularMaterial(A(), c.ghe, inativo);
      const inativoDoTipo = await a.material(A(), { nome: 'F3 inativo do tipo', tipoLinha: t, ativo: false }); await a.vincularTipo(A(), c.ghe, t.id);
      const antes = await a.fotografia();
      for (const m of [inativo, inativoDoTipo]) {
        const r = await enviar(c, [a.item(m)]);
        assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO_ITEM, aviso(r));
      }
      await exigirNadaCriado(c, antes, 'F3');
    });

    test('F4 — TIPO genérico não é item: o id de um tipo do catálogo usado como materialId, um campo de tipo no corpo e um tipo ligado ao GHE sem material válido são recusados', async () => {
      const c = await montar();
      const soTipo = await a.tipo(A()); await a.vincularTipo(A(), c.ghe, soTipo.id);
      const antes = await a.fotografia();
      const semMaterialNaEmpresa = await enviar(c, [a.item(999999999)]);
      assert.deepEqual([semMaterialNaEmpresa.status, semMaterialNaEmpresa.body.codigo], NAO_AUTORIZADO_ITEM, aviso(semMaterialNaEmpresa));
      for (const extra of [{ tipoId: soTipo.id }, { tipoMaterialId: soTipo.id }]) {
        const r = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: a.chave(), itens: [{ ...a.item(c.unico), ...extra }] });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], aviso(r));
      }
      await exigirNadaCriado(c, antes, 'F4');
    });

    test('F5 — tamanho VÁLIDO aceito: o da grade cadastrada e, no legado sem grade, um dos tamanhos dos lotes (os mesmos que o catálogo ofereceu)', async () => {
      const c = await montar();
      const legado = await a.material(A(), { nome: 'F5 legado', exigeTamanho: true, lotes: [{ tamanho: '42', quantidade: 3 }] });
      await a.vincularMaterial(A(), c.ghe, legado);
      const r = await enviar(c, [a.item(c.comGrade, { tamanho: 'G' }), a.item(legado, { tamanho: '42' })]);
      assert.equal(r.status, 201, aviso(r));
      const [sol] = await a.solicitacoesDe(c.f.id);
      assert.deepEqual((await a.itensDe(sol.id)).map((i) => [i.material_id, i.tamanho]).sort(), [[c.comGrade, 'G'], [legado, '42']].sort());
    });

    test('F6 — tamanho INEXISTENTE recusado (400 TAMANHO_FORA_DA_GRADE no caminho do item): fora da grade, caixa diferente e, no legado, tamanho sem lote; nada é criado', async () => {
      const c = await montar();
      const legado = await a.material(A(), { nome: 'F6 legado', exigeTamanho: true, lotes: [{ tamanho: '42', quantidade: 3 }] }); await a.vincularMaterial(A(), c.ghe, legado);
      const antes = await a.fotografia();
      for (const [m, tamanho] of [[c.comGrade, 'XG'], [c.comGrade, 'p'], [legado, '50']]) {
        const r = await enviar(c, [a.item(m, { tamanho })]);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], aviso(r));
        assert.deepEqual(r.body.detalhes.map((d) => [d.campo, d.codigo]), [['body.itens[0].tamanho', 'TAMANHO_FORA_DA_GRADE']]);
      }
      await exigirNadaCriado(c, antes, 'F6');
    });

    test('F7 — material SEM exigência de tamanho: sem tamanho aceito; com tamanho é 400 TAMANHO_NAO_SE_APLICA; e o que exige tamanho sem tamanho é 400 TAMANHO_OBRIGATORIO', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      const comTamanho = await enviar(c, [a.item(c.unico, { tamanho: 'M' })]);
      assert.deepEqual(comTamanho.body.detalhes?.map((d) => d.codigo), ['TAMANHO_NAO_SE_APLICA'], aviso(comTamanho));
      const semTamanho = await enviar(c, [a.item(c.comGrade)]);
      assert.deepEqual(semTamanho.body.detalhes?.map((d) => d.codigo), ['TAMANHO_OBRIGATORIO'], aviso(semTamanho));
      await exigirNadaCriado(c, antes, 'F7');
      assert.equal((await enviar(c, [a.item(c.unico)])).status, 201);
    });

    test('F8 — QUANTIDADE válida pela regra existente da 12G: inteiro positivo, sem teto de negócio (até o limite técnico do inteiro) — 1, 3 e 500 são aceitas', async () => {
      for (const quantidade of [1, 3, 500]) {
        const c = await montar();
        const r = await enviar(c, [a.item(c.unico, { quantidade })]);
        assert.equal(r.status, 201, `${quantidade}: ${aviso(r)}`);
        const [sol] = await a.solicitacoesDe(c.f.id);
        assert.equal((await a.itensDe(sol.id))[0].quantidade, quantidade);
      }
    });

    test('F9 — QUANTIDADE inválida recusada (400 VALIDACAO): zero, negativa, fracionária, texto, nula, acima do limite do inteiro; motivo ausente/inválido e "OUTRO" sem justificativa também', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      const invalidas = [0, -1, 1.5, '2', null, 2147483648];
      for (const quantidade of invalidas) {
        const r = await enviar(c, [a.item(c.unico, { quantidade })]);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${String(quantidade)}: ${aviso(r)}`);
      }
      // D-F2: o Totem só oferece SUBSTITUICAO_PRAZO, DESGASTE_DANO e PERDA_EXTRAVIO; ADMISSAO e OUTRO (e texto livre) são recusados.
      for (const extra of [{ motivo: undefined }, { motivo: 'QUALQUER' }, { motivo: 'OUTRO' }, { motivo: 'ADMISSAO' }, { motivo: 'OUTRO', justificativa: 'texto livre' }, { motivo: 'PERDA_EXTRAVIO', justificativa: 'texto livre' }, { observacao: 'texto livre' }]) {
        const r = await enviar(c, [a.item(c.unico, extra)]);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], aviso(r));
      }
      await exigirNadaCriado(c, antes, 'F9');
    });

    test('F9b — cada um dos três motivos do Totem (SUBSTITUICAO_PRAZO, DESGASTE_DANO, PERDA_EXTRAVIO) é aceito e gravado no item; o motivo viaja para a solicitação sem justificativa', async () => {
      for (const motivo of ['SUBSTITUICAO_PRAZO', 'DESGASTE_DANO', 'PERDA_EXTRAVIO']) {
        const c = await montar();
        const r = await enviar(c, [a.item(c.unico, { motivo })]);
        assert.equal(r.status, 201, `${motivo}: ${aviso(r)}`);
        const [sol] = await a.solicitacoesDe(c.f.id);
        const [linha] = await a.itensDe(sol.id);
        assert.equal(linha.motivo, motivo);
        assert.equal(linha.justificativa ?? null, null, `${motivo}: sem texto livre`);
        assert.equal(sol.observacao ?? null, null, `${motivo}: sem observação`);
      }
    });

    test('F10 — material autorizado SEM estoque pode ser solicitado: sem lote, com lote zerado e com o tamanho da grade sem nenhum saldo; o saldo não bloqueia o envio nem é lido na resposta', async () => {
      const c = await montar();
      const zerado = await a.material(A(), { nome: 'F10 zerado', exigeTamanho: true, grade: ['P'], lotes: [{ tamanho: 'P', quantidade: 0 }] });
      await a.vincularMaterial(A(), c.ghe, zerado);
      const r = await enviar(c, [a.item(c.unico), a.item(zerado, { tamanho: 'P' }), a.item(c.comGrade, { tamanho: 'M' })]);
      assert.equal(r.status, 201, aviso(r));
      assert.equal(/saldo|estoque|disponivel|cobertura|posicao|lote/i.test(JSON.stringify(r.body)), false);
    });

    test('F11 — CARRINHO com múltiplos itens válidos (inclusive por tipo e o limite de 20 itens): um pedido só, com todos os itens, em ordem canônica, quantidade_itens correto; 21 itens ou item repetido (mesmo material e tamanho) são 400', async () => {
      const c = await montar();
      const r = await enviar(c, [a.item(c.comGrade, { tamanho: 'G', quantidade: 2 }), a.item(c.porTipo, { quantidade: 4 }), a.item(c.comGrade, { tamanho: 'P' }), a.item(c.unico)]);
      assert.equal(r.status, 201, aviso(r));
      assert.equal(r.body.pedido.quantidadeItens, 4);
      const sols = await a.solicitacoesDe(c.f.id);
      assert.equal(sols.length, 1);
      assert.equal((await a.itensDe(sols[0].id)).length, 4);
      const c2 = await montar();
      const antes = await a.fotografia();
      const repetido = await enviar(c2, [a.item(c2.comGrade, { tamanho: 'P' }), a.item(c2.comGrade, { tamanho: 'P', quantidade: 2 })]);
      assert.deepEqual([repetido.status, repetido.body.codigo], [400, 'VALIDACAO'], aviso(repetido));
      const muitos = await a.q(`INSERT INTO materiais (empresa_id, nome, exige_ca, exige_tamanho, prazo_uso_dias) SELECT $1, 'F11 mat ' || g, true, false, 180 FROM generate_series(1, 21) g RETURNING id`, [A()]);
      const vinculos = muitos.rows.map((m) => m.id);
      await a.q('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) SELECT $1, $2, x FROM unnest($3::int[]) x', [A(), c2.ghe, vinculos]);
      const vinteEUm = await enviar(c2, vinculos.map((id) => a.item(id)));
      assert.deepEqual([vinteEUm.status, vinteEUm.body.codigo], [400, 'VALIDACAO'], aviso(vinteEUm));
      await exigirNadaCriado(c2, antes, 'F11');
      assert.equal((await enviar(c2, vinculos.slice(0, 20).map((id) => a.item(id)))).status, 201, '20 itens é o limite aceito');
    });

    test('F12 — um item inválido NÃO contamina o pedido válido: o pedido é atômico (nenhum item entra), o número não é consumido, a chave não fica queimada e o MESMO carrinho corrigido é aceito depois com a mesma chave', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      const chave = a.chave();
      const ruim = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: chave, itens: [a.item(c.unico), a.item(c.comGrade, { tamanho: 'XG' }), a.item(c.porTipo)] });
      assert.deepEqual([ruim.status, ruim.body.codigo], [400, 'VALIDACAO'], aviso(ruim));
      await exigirNadaCriado(c, antes, 'F12');
      assert.equal((await atendimentoDe(c)).encerrado_em, null, 'o atendimento segue aberto para o funcionário corrigir');
      const certo = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: chave, itens: [a.item(c.unico), a.item(c.comGrade, { tamanho: 'G' }), a.item(c.porTipo)] });
      assert.equal(certo.status, 201, aviso(certo));
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
    });
  });

  // ───────────────────────── contexto vivo: GHE, funcionário, material, atendimento, tablet ─────────────────────────
  describe('revalidação no envio e atendimento', () => {
    test('F13 — o GHE é REVALIDADO no envio, com o estado de agora: GHE trocado, vínculo removido ou tipo desativado depois do catálogo recusam o item; o pedido que sai fica com o GHE ATUAL; GHE inativado dá 409 sem criar nada', async () => {
      const antes0 = await a.fotografia();
      const c = await montar();
      const outroGhe = await a.ghe(A());
      await a.vincularMaterial(A(), outroGhe, c.unico);
      await a.q('UPDATE funcionarios SET grupo_homogeneo_id = $2 WHERE id = $1', [c.f.id, outroGhe]);
      const trocado = await enviar(c, [a.item(c.comGrade, { tamanho: 'M' })]);
      assert.deepEqual([trocado.status, trocado.body.codigo], NAO_AUTORIZADO_ITEM, 'o material só autorizado no GHE antigo');
      const c2 = await montar();
      await a.q('DELETE FROM ghe_materiais WHERE grupo_homogeneo_id = $1 AND material_id = $2', [c2.ghe, c2.unico]);
      assert.deepEqual([(await enviar(c2, [a.item(c2.unico)])).body.codigo], ['ITEM_NAO_AUTORIZADO']);
      await a.q('UPDATE tipos_material SET ativo = false WHERE id = $1', [c2.tipo.id]);
      assert.deepEqual([(await enviar(c2, [a.item(c2.porTipo)])).body.codigo], ['ITEM_NAO_AUTORIZADO'], 'tipo inativo não concede (regra do catálogo)');
      const c3 = await montar();
      await a.q('UPDATE grupos_homogeneos_exposicao SET ativo = false WHERE id = $1', [c3.ghe]);
      const gheInativo = await enviar(c3, [a.item(c3.unico)]);
      assert.deepEqual([gheInativo.status, gheInativo.body.codigo], NAO_AUTORIZADO_ITEM, aviso(gheInativo));
      const c4 = await montar();
      const novoGhe = await a.ghe(A()); const materialNovo = await a.material(A(), { nome: 'F13 novo' }); await a.vincularMaterial(A(), novoGhe, materialNovo);
      await a.q('UPDATE funcionarios SET grupo_homogeneo_id = $2 WHERE id = $1', [c4.f.id, novoGhe]);
      const ok = await enviar(c4, [a.item(materialNovo)]);
      assert.equal(ok.status, 201, aviso(ok));
      assert.equal((await a.solicitacoesDe(c4.f.id))[0].ghe_id, novoGhe, 'o GHE gravado é o de agora');
      assert.equal((await a.fotografia()).solicitacoes, antes0.solicitacoes + 1, 'só o último pedido foi criado');
    });

    test('F14 — funcionário INATIVADO ou AFASTADO durante a sessão: 401 ATENDIMENTO_INVALIDO (regra da Etapa D), nada criado e o atendimento NÃO consta como pedido enviado', async () => {
      for (const situacao of ['AFASTADO', 'INATIVO']) {
        const c = await montar();
        const antes = await a.fotografia();
        await a.q('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [c.f.id, situacao]);
        const r = await enviar(c, [a.item(c.unico)]);
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `${situacao}: ${aviso(r)}`);
        await exigirNadaCriado(c, antes, situacao);
      }
    });

    test('F15 — material INATIVADO entre o catálogo e o envio: 409 ITEM_NAO_AUTORIZADO e o carrinho inteiro é recusado; reativado, o mesmo carrinho passa', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      await a.q('UPDATE materiais SET ativo = false WHERE id = $1', [c.unico]);
      const chave = a.chave();
      const r = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: chave, itens: [a.item(c.comGrade, { tamanho: 'M' }), a.item(c.unico)] });
      assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO_ITEM, aviso(r));
      assert.equal(r.body.detalhes[0].campo, 'body.itens[1].materialId');
      await exigirNadaCriado(c, antes, 'F15');
      await a.q('UPDATE materiais SET ativo = true WHERE id = $1', [c.unico]);
      assert.equal((await a.finalizar(app, c.t, c.token, { chaveIdempotencia: chave, itens: [a.item(c.comGrade, { tamanho: 'M' }), a.item(c.unico)] })).status, 201);
    });

    test('F16 — atendimento EXPIRADO: 401 ATENDIMENTO_INVALIDO, cookie removido, nenhuma solicitação, nenhum número consumido, e o registro não vira PEDIDO_ENVIADO', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      await forcarRestante(c.atendimentoId, -10);
      const r = await enviar(c, [a.item(c.unico)]);
      assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      assert.ok(lerSetCookie(r).some((x) => x.nome === COOKIE_ATENDIMENTO && x.atributos['max-age'] === '0'));
      await exigirNadaCriado(c, antes, 'F16');
      assert.ok([null, 'INATIVIDADE'].includes((await atendimentoDe(c)).motivo_encerramento));
    });

    test('F17 — atendimento SUBSTITUÍDO: o token antigo não registra pedido (401), nem em nome do funcionário seguinte; o atendimento novo registra o seu normalmente e o carrinho do anterior não aparece nele', async () => {
      const c = await montar();
      const outro = await a.funcionarioNoGhe(A(), c.ghe);
      const novo = await a.identificar(app, c.t.credencial, { tipo: 'CPF', valor: outro.cpf });
      assert.equal(novo.status, 201, aviso(novo));
      const tokenNovo = cookieDoAtendimentoNaResposta(novo).valor;
      const antes = await a.fotografia();
      const atrasado = await enviar(c, [a.item(c.unico)]);
      assert.deepEqual([atrasado.status, atrasado.body.codigo], ATENDIMENTO_INVALIDO, aviso(atrasado));
      assert.deepEqual(await a.fotografia(), antes);
      const ok = await a.finalizar(app, c.t, tokenNovo, a.corpo([a.item(c.comGrade, { tamanho: 'P' })]));
      assert.equal(ok.status, 201, aviso(ok));
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 0, 'nada em nome do funcionário anterior');
      assert.equal((await a.solicitacoesDe(outro.id)).length, 1);
    });

    test('F18 — tablet REVOGADO: 401 DISPOSITIVO_NAO_AUTORIZADO; REATIVADO: a credencial antiga é 401 e o atendimento aberto ANTES da reativação é 401 também com a credencial nova; um atendimento aberto depois registra normalmente; nada é criado nas recusas', async () => {
      const revogado = await montar();
      const antes = await a.fotografia();
      assert.equal((await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${revogado.t.id}/revogar`)).status, 200);
      const r1 = await enviar(revogado, [a.item(revogado.unico)]);
      assert.deepEqual([r1.status, r1.body.codigo], NAO_AUTORIZADO, aviso(r1));
      const c = await montar();
      const nova = cookieDoTabletNaResposta(await a.ativar(app, await gerarCodigo(c.t.id))).valor;
      const antiga = await enviar(c, [a.item(c.unico)]);
      assert.deepEqual([antiga.status, antiga.body.codigo], NAO_AUTORIZADO, aviso(antiga));
      const anterior = await a.finalizar(app, { credencial: nova }, c.token, a.corpo([a.item(c.unico)]));
      assert.deepEqual([anterior.status, anterior.body.codigo], ATENDIMENTO_INVALIDO, aviso(anterior));
      assert.deepEqual(await a.fotografia(), antes, 'nenhuma recusa criou algo');
      const depois = await a.identificar(app, nova, { tipo: 'CPF', valor: c.f.cpf });
      assert.equal(depois.status, 201, aviso(depois));
      const ok = await a.finalizar(app, { credencial: nova }, cookieDoAtendimentoNaResposta(depois).valor, a.corpo([a.item(c.unico)]));
      assert.equal(ok.status, 201, aviso(ok));
    });

    test('F18b — a JANELA da reativação (pool instrumentado, sem sleep): atendimento aberto durante a transação de reativação já iniciada é recusado com a credencial nova (401 ATENDIMENTO_INVALIDO) e nada é criado', async () => {
      const ghe = await a.ghe(A()); const m = await a.material(A(), { nome: 'F18b material' }); await a.vincularMaterial(A(), ghe, m);
      const f = await a.funcionarioNoGhe(A(), ghe); const t = await a.tabletNovo();
      const codigo = await gerarCodigo(t.id);
      const instr = a.poolInstrumentado([{ nome: 'trava', casa: /FOR UPDATE OF d/, acao: 'pausar' }]);
      const ativacao = tokenTabletService.ativar(instr.pool, { codigo, ip: IP_TESTE, agente: null });
      await Promise.race([instr.pausado('trava'), new Promise((_, rej) => setTimeout(() => rej(new Error('a reativação não chegou à trava')), LIMITE_DE_SEGURANCA_MS))]);
      const identificacao = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
      assert.equal(identificacao.status, 201, aviso(identificacao));
      const token = cookieDoAtendimentoNaResposta(identificacao).valor;
      instr.liberar('trava');
      const { credencial: nova } = await ativacao;
      const antes = await a.fotografia();
      const r = await a.finalizar(app, { credencial: nova }, token, a.corpo([a.item(m)]));
      assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      assert.deepEqual(await a.fotografia(), antes);
    });

    test('F19 — ISOLAMENTO multiempresa: material (e GHE) de nomes idênticos na empresa B não é aceito para a A; o pedido nasce só na A, com tablet, funcionário e lateral da A; nada na B muda; o banco recusa lateral cruzada', async () => {
      const gheB = await a.ghe(a.d.empresaB); const mB = await a.material(a.d.empresaB, { nome: 'F Protetor' }); await a.vincularMaterial(a.d.empresaB, gheB, mB);
      const c = await montar();
      const antesB = (await a.q('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE empresa_id = $1', [a.d.empresaB])).rows[0].n;
      const cruzado = await enviar(c, [a.item(mB)]);
      assert.deepEqual([cruzado.status, cruzado.body.codigo], NAO_AUTORIZADO_ITEM, aviso(cruzado));
      const ok = await enviar(c, [a.item(c.unico)]);
      assert.equal(ok.status, 201, aviso(ok));
      const [sol] = await a.solicitacoesDe(c.f.id);
      assert.equal(sol.empresa_id, A());
      assert.equal((await a.lateralDe(sol.id)).empresa_id, A());
      assert.equal((await a.q('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE empresa_id = $1', [a.d.empresaB])).rows[0].n, antesB);
      await assert.rejects(() => a.q('UPDATE solicitacoes_autoatendimento SET empresa_id = $1 WHERE solicitacao_id = $2', [a.d.empresaB, sol.id]));
    });

    test('F20 — parâmetros de IDENTIDADE manipulados são 400 (empresa, funcionário, GHE, tablet, atendimento, origem, solicitante, status, número, decisão) e nada vale: query e cabeçalhos x-* não mudam o dono do pedido', async () => {
      const c = await montar();
      const outro = await a.funcionarioNoGhe(A(), c.ghe);
      const antes = await a.fotografia();
      const extras = [
        { empresaId: a.d.empresaB }, { funcionarioId: outro.id }, { gheId: 1 }, { dispositivoId: 1 }, { atendimentoId: 1 }, { origemSolicitacao: 'USUARIO_INTERNO' },
        { solicitanteUsuarioId: a.d.master }, { status: 'APROVADA' }, { numero: 1 }, { decisao: 'APROVADO' }, { observacao: 'x' }, { tipo: 'CPF', valor: outro.cpf },
      ];
      for (const extra of extras) {
        const r = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: a.chave(), itens: [a.item(c.unico)], ...extra });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${Object.keys(extra)[0]}: ${aviso(r)}`);
      }
      const comQuery = await request(app).post(`${PEDIDO}?empresaId=${a.d.empresaB}&funcionarioId=${outro.id}`).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(c.t.credencial, c.token)).send(a.corpo([a.item(c.unico)]));
      assert.deepEqual([comQuery.status, comQuery.body.codigo], [400, 'VALIDACAO'], aviso(comQuery));
      await exigirNadaCriado(c, antes, 'F20');
      const ok = await a.finalizar(app, c.t, c.token, a.corpo([a.item(c.unico)]), { 'x-empresa-id': String(a.d.empresaB), 'x-funcionario-id': String(outro.id), 'x-ghe-id': '999' });
      assert.equal(ok.status, 201, aviso(ok));
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
      assert.equal((await a.solicitacoesDe(outro.id)).length, 0);
    });
  });

  // ───────────────────────── idempotência, concorrência e fronteira transacional ─────────────────────────
  describe('idempotência e fronteira transacional', () => {
    test('F21 — DUPLO CLIQUE: duas finalizações simultâneas com a mesma chave e o mesmo carrinho geram UMA solicitação, UMA lateral, UMA auditoria de criação e um único encerramento PEDIDO_ENVIADO; as duas respostas trazem o MESMO número', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.unico, { quantidade: 2 }), a.item(c.comGrade, { tamanho: 'M' })]);
      const antesAuditorias = (await a.auditorias('SOLICITACAO_EPI_CRIADA')).length;
      const [r1, r2] = await Promise.all([a.finalizar(app, c.t, c.token, payload), a.finalizar(app, c.t, c.token, payload)]);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 201], `${aviso(r1)} | ${aviso(r2)}`);
      assert.equal(r1.body.pedido.numero, r2.body.pedido.numero);
      assert.deepEqual([r1.body.pedido.numero, r2.body.pedido.numero].map(numeroDoPedidoValido), [true, true], 'o 201 e o 200 repetido trazem o número como inteiro');
      assert.deepEqual([r1.body.repetida, r2.body.repetida].sort(), [false, true]);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
      assert.equal((await a.q('SELECT count(*)::int AS n FROM solicitacoes_autoatendimento WHERE atendimento_id = $1', [c.atendimentoId])).rows[0].n, 1);
      assert.equal((await a.auditorias('SOLICITACAO_EPI_CRIADA')).length, antesAuditorias + 1);
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'PEDIDO_ENVIADO');
    });

    test('F21b — DUPLO CLIQUE determinístico (pool instrumentado, sem sleep): a primeira finalização fica PAUSADA dentro da transação, já com a chave e o tablet travados; a segunda (mesma chave e carrinho) ESPERA e, depois do COMMIT da primeira, recebe o resultado ORIGINAL (200 repetida:true) — nunca um 401 por atendimento já encerrado nem um segundo pedido', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.unico, { quantidade: 2 })]);
      const instr = a.poolInstrumentado([{ nome: 'gravando', casa: /INSERT INTO solicitacoes_epi\s*\(/, acao: 'pausar' }]);
      const lenta = a.criarApp({ hops: 0, pool: instr.pool });
      const primeira = a.finalizar(lenta, c.t, c.token, payload).then((x) => x);
      let segunda;
      try {
        await Promise.race([instr.pausado('gravando'), primeira.then((x) => assert.fail(`a primeira terminou sem gravar: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('a primeira não chegou a gravar')), LIMITE_DE_SEGURANCA_MS))]);
        segunda = a.finalizar(app, c.t, c.token, payload).then((x) => x);
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        let terminou = false;
        segunda.then(() => { terminou = true; });
        while (!terminou && (await esperando(instr.pid('gravando'))) === 0) {
          if (Date.now() > prazo) assert.fail('a segunda finalização não chegou a esperar a primeira');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'a segunda deveria ESPERAR a primeira terminar');
      } finally { instr.liberar('gravando'); }
      const [r1, r2] = [await primeira, await segunda];
      assert.equal(r1.status, 201, aviso(r1));
      assert.equal(r2.status, 200, aviso(r2));
      assert.deepEqual([r2.body.repetida, r2.body.pedido], [true, r1.body.pedido]);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
    });

    test('F22 — RETRY com a mesma chave (depois do sucesso, com o cookie que o tablet ainda tem): 200 repetida:true com o resultado ORIGINAL, sem novo número nem nova linha; a mesma chave com OUTRO carrinho é 409 IDEMPOTENCIA_CONFLITO', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.unico)]);
      const primeira = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(primeira.status, 201, aviso(primeira));
      const antes = await a.fotografia();
      const retry = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(retry.status, 200, aviso(retry));
      assert.equal(retry.body.repetida, true);
      assert.deepEqual(retry.body.pedido, primeira.body.pedido);
      assert.deepEqual(await a.fotografia(), antes);
      const outroCarrinho = await a.finalizar(app, c.t, c.token, { chaveIdempotencia: payload.chaveIdempotencia, itens: [a.item(c.unico, { quantidade: 7 })] });
      assert.deepEqual([outroCarrinho.status, outroCarrinho.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO'], aviso(outroCarrinho));
    });

    test('F23 — REQUISIÇÕES SIMULTÂNEAS: (a) seis chaves diferentes no MESMO atendimento → exatamente um pedido (as demais 401 por atendimento já encerrado); (b) determinístico: a substituição do atendimento enquanto a finalização espera a trava do tablet → a finalização é 401 e nada é criado', async () => {
      const c = await montar();
      const respostas = await Promise.all(Array.from({ length: 6 }, () => a.finalizar(app, c.t, c.token, a.corpo([a.item(c.unico)]))));
      assert.equal(respostas.filter((r) => r.status === 201).length, 1, respostas.map((r) => r.status).join(','));
      assert.ok(respostas.filter((r) => r.status !== 201).every((r) => r.status === 401 && r.body.codigo === 'ATENDIMENTO_INVALIDO'));
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);

      const d = await montar();
      const antes = await a.fotografia();
      const concorrente = await a.ctx.pool.connect();
      try {
        await concorrente.query('BEGIN');
        await concorrente.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [d.t.id]);
        const pid = (await concorrente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let terminou = false;
        const resposta = enviar(d, [a.item(d.unico)]).then((r) => { terminou = true; return r; });
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        while (!terminou && (await esperando(pid)) === 0) {
          if (Date.now() > prazo) assert.fail('a finalização não chegou a esperar a trava do tablet');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'a finalização deveria esperar a trava do tablet');
        await concorrente.query("UPDATE token_atendimentos SET encerrado_em = clock_timestamp(), motivo_encerramento = 'SUBSTITUIDO' WHERE id = $1", [d.atendimentoId]);
        await concorrente.query('COMMIT');
        const r = await resposta;
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      } finally { await concorrente.query('ROLLBACK').catch(() => {}); concorrente.release(); }
      await exigirNadaCriado(d, antes, 'F23b');
    });

    test('F23c — DUAS CHAVES DIFERENTES, DETERMINÍSTICO (pool instrumentado, sem sleep): a primeira finalização fica PAUSADA dentro da transação; a segunda (OUTRA chave, outro carrinho) ESPERA a trava do tablet e, depois do COMMIT, recebe 401 ATENDIMENTO_INVALIDO; existe UMA solicitação só', async () => {
      const c = await montar();
      const instr = a.poolInstrumentado([{ nome: 'gravando', casa: /INSERT INTO solicitacoes_epi\s*\(/, acao: 'pausar' }]);
      const lenta = a.criarApp({ hops: 0, pool: instr.pool });
      const primeira = a.finalizar(lenta, c.t, c.token, a.corpo([a.item(c.unico)])).then((x) => x);
      let segunda;
      try {
        await Promise.race([instr.pausado('gravando'), primeira.then((x) => assert.fail(`a primeira terminou sem gravar: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('a primeira não chegou a gravar')), LIMITE_DE_SEGURANCA_MS))]);
        segunda = a.finalizar(app, c.t, c.token, a.corpo([a.item(c.comGrade, { tamanho: 'M', quantidade: 3, motivo: 'PERDA_EXTRAVIO' })])).then((x) => x);
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        let terminou = false;
        segunda.then(() => { terminou = true; });
        while (!terminou && (await esperando(instr.pid('gravando'))) === 0) {
          if (Date.now() > prazo) assert.fail('a segunda finalização não chegou a esperar a primeira');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'a segunda deveria ESPERAR a primeira terminar');
      } finally { instr.liberar('gravando'); }
      const [r1, r2] = [await primeira, await segunda];
      assert.equal(r1.status, 201, aviso(r1));
      assert.deepEqual([r2.status, r2.body.codigo], ATENDIMENTO_INVALIDO, aviso(r2));
      const solicitacoes = await a.solicitacoesDe(c.f.id);
      assert.equal(solicitacoes.length, 1);
      assert.equal(solicitacoes[0].numero, r1.body.pedido.numero);
      assert.equal(String((await a.lateralDe(solicitacoes[0].id)).atendimento_id), String(c.atendimentoId));
    });

    test('F24b — LIMITES da recuperação (D-F6): a chave sozinha NÃO recupera. Sem o cookie do atendimento, sem a credencial do tablet, com o cookie de OUTRO funcionário, de outro tablet ou com um NOVO atendimento do mesmo funcionário o resultado nunca é entregue; o atendimento encerrado não é reaberto', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.unico)]);
      const gravado = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(gravado.status, 201, aviso(gravado));
      const antes = await a.fotografia();

      const semAtendimento = await a.resultado(app, c.t, null, payload.chaveIdempotencia);
      assert.deepEqual([semAtendimento.status, semAtendimento.body.codigo], ATENDIMENTO_INVALIDO, aviso(semAtendimento));
      const semTablet = await a.resultado(app, null, c.token, payload.chaveIdempotencia);
      assert.deepEqual([semTablet.status, semTablet.body.codigo], NAO_AUTORIZADO, aviso(semTablet));

      const outroFuncionario = await a.cenario(app, { gheId: c.gheId, tablet: c.t });
      const doOutro = await a.resultado(app, c.t, outroFuncionario.token, payload.chaveIdempotencia);
      assert.deepEqual([doOutro.status, doOutro.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], aviso(doOutro));
      const emOutroTablet = await a.cenario(app, { gheId: c.gheId });
      const cruzado = await a.resultado(app, c.t, emOutroTablet.token, payload.chaveIdempotencia);
      assert.deepEqual([cruzado.status, cruzado.body.codigo], ATENDIMENTO_INVALIDO, aviso(cruzado));

      // O mesmo funcionário, num atendimento NOVO, não "herda" o pedido do anterior pela chave: a recuperação pertence ao atendimento, não à pessoa.
      const mesmoFuncionario = await a.identificar(app, c.t.credencial, { tipo: 'CPF', valor: c.f.cpf });
      assert.equal(mesmoFuncionario.status, 201, aviso(mesmoFuncionario));
      const tokenNovo = cookieDoAtendimentoNaResposta(mesmoFuncionario).valor;
      const novo = await a.resultado(app, c.t, tokenNovo, payload.chaveIdempotencia);
      assert.deepEqual([novo.status, novo.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], aviso(novo));
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'PEDIDO_ENVIADO', 'o atendimento encerrado não é reaberto');
      assert.equal((await atendimentoDe(c)).encerrado_em === null, false);
      const reenvio = await a.finalizar(app, c.t, tokenNovo, payload);
      assert.deepEqual([reenvio.status, reenvio.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO'], 'a mesma chave não vale em outro atendimento do mesmo funcionário');
      const depois = await a.fotografia();
      assert.deepEqual(depois, antes, 'nenhuma dessas tentativas criou ou alterou coisa alguma');
    });

    test('F24 — RESPOSTA PERDIDA depois do pedido gravado: o tablet consulta o resultado pela chave e recebe REGISTRADO com o número; repetir o POST devolve o original; outro atendimento não vê o pedido (404); o atendimento já está encerrado como PEDIDO_ENVIADO', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.unico)]);
      const gravado = await a.finalizar(app, c.t, c.token, payload); // a resposta "se perde": o teste só usa o banco e a chave depois
      assert.equal(gravado.status, 201, aviso(gravado));
      const consulta = await a.resultado(app, c.t, c.token, payload.chaveIdempotencia);
      assert.equal(consulta.status, 200, aviso(consulta));
      assert.deepEqual(consulta.body.pedido, { estado: 'REGISTRADO', numero: gravado.body.pedido.numero, status: 'PENDENTE', quantidadeItens: 1 });
      assert.equal(numeroDoPedidoValido(consulta.body.pedido.numero), true, 'o GET REGISTRADO também traz o número como inteiro');
      assert.deepEqual(lerSetCookie(consulta), [], 'a consulta de resultado nunca emite nem renova cookie');
      assert.equal(JSON.stringify(consulta.body).includes(payload.chaveIdempotencia), false, 'a chave não volta no corpo');
      const outro = await a.cenario(app, { gheId: c.gheId });
      const alheio = await a.resultado(app, outro.t, outro.token, payload.chaveIdempotencia);
      assert.deepEqual([alheio.status, alheio.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], aviso(alheio));
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'PEDIDO_ENVIADO');
    });

    test('F25 — pedido ACEITO antes de expirar: a finalização que já passou da validação NÃO é cancelada pela expiração do atendimento durante o processamento (pool instrumentado, sem sleep): o COMMIT acontece, 201, PEDIDO_ENVIADO gravado, sem duplicar', async () => {
      const c = await montar();
      await forcarRestante(c.atendimentoId, 5);
      const instr = a.poolInstrumentado([{ nome: 'gravando', casa: /INSERT INTO solicitacoes_epi\s*\(/, acao: 'pausar' }]);
      const aplicacao = a.criarApp({ hops: 0, pool: instr.pool });
      // `.then` dispara a requisição (o supertest é preguiçoso); a liberação final garante que uma falha antecipada não deixe a transação pausada.
      const resposta = a.finalizar(aplicacao, c.t, c.token, a.corpo([a.item(c.unico)])).then((x) => x);
      let r;
      try {
        await Promise.race([instr.pausado('gravando'), resposta.then((x) => assert.fail(`a finalização terminou sem gravar: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('a finalização não chegou a gravar')), LIMITE_DE_SEGURANCA_MS))]);
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        while (!(await a.q('SELECT clock_timestamp() > expira_em AS vencido FROM token_atendimentos WHERE id = $1', [c.atendimentoId])).rows[0].vencido) {
          if (Date.now() > prazo) assert.fail('o atendimento não expirou no limite do teste');
          await new Promise((resolver) => setImmediate(resolver));
        }
      } finally { instr.liberar('gravando'); }
      r = await resposta;
      assert.equal(r.status, 201, `o pedido já aceito não pode ser cancelado pela expiração: ${aviso(r)}`);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'PEDIDO_ENVIADO');
    });

    test('F26 — pedido NÃO aceito antes de expirar: a finalização que espera a trava do tablet enquanto o atendimento expira é RECUSADA (401), nada é criado e a expiração não é tratada como pedido enviado', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      await forcarRestante(c.atendimentoId, 30);
      const concorrente = await a.ctx.pool.connect();
      try {
        await concorrente.query('BEGIN');
        await concorrente.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [c.t.id]);
        const pid = (await concorrente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let terminou = false;
        const resposta = enviar(c, [a.item(c.unico)]).then((r) => { terminou = true; return r; });
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        while (!terminou && (await esperando(pid)) === 0) {
          if (Date.now() > prazo) assert.fail('a finalização não chegou a esperar a trava do tablet');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false);
        await forcarRestante(c.atendimentoId, -5);
        await concorrente.query('COMMIT');
        const r = await resposta;
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      } finally { await concorrente.query('ROLLBACK').catch(() => {}); concorrente.release(); }
      await exigirNadaCriado(c, antes, 'F26');
    });

    test('F27 — o pedido NÃO baixa nem reserva estoque: lotes (entrada, baixa, entrega), operações e a posição derivada do par ficam idênticos antes e depois da criação, com e sem saldo', async () => {
      const c = await montar();
      await criarLote(a.ctx.pool, { empresaId: A(), materialId: c.comGrade, quantidade: 4, tamanho: 'M' });
      const lerPosicao = () => coberturaRepo.lerPosicoes(a.ctx.pool, A(), [{ materialId: c.comGrade, tamanho: 'M' }], { hoje: dataOperacional() });
      const antes = await a.fotografia(); const posicaoAntes = await lerPosicao();
      const r = await enviar(c, [a.item(c.comGrade, { tamanho: 'M', quantidade: 3 }), a.item(c.unico, { quantidade: 9 })]);
      assert.equal(r.status, 201, aviso(r));
      const depois = await a.fotografia();
      assert.deepEqual([depois.lotesBaixado, depois.lotesEntregue, depois.lotesEntrada, depois.operacoes], [antes.lotesBaixado, antes.lotesEntregue, antes.lotesEntrada, antes.operacoes]);
      assert.deepEqual(await lerPosicao(), posicaoAntes, 'a posição derivada (físico, demanda aprovada, saldo livre) não mudou: pedido PENDENTE não reserva');
    });

    test('F28 — o pedido NÃO registra entrega nem atualiza a ficha de EPI: entregas, itens de entrega, fichas e numeração da ficha ficam idênticos', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      const antesNumeracaoFicha = (await a.q('SELECT COALESCE(sum(ultimo_numero), 0)::int AS v FROM fichas_epi_numeracao')).rows[0].v;
      const r = await enviar(c, [a.item(c.unico)]);
      assert.equal(r.status, 201, aviso(r));
      const depois = await a.fotografia();
      assert.deepEqual([depois.entregas, depois.entregaItens, depois.fichas], [antes.entregas, antes.entregaItens, antes.fichas]);
      assert.equal((await a.q('SELECT COALESCE(sum(ultimo_numero), 0)::int AS v FROM fichas_epi_numeracao')).rows[0].v, antesNumeracaoFicha);
      assert.equal(depois.solicitacoes, antes.solicitacoes + 1);
    });

    test('F29 — origem AUTOATENDIMENTO e RASTREABILIDADE: auditoria SOLICITACAO_EPI_CRIADA (origem, funcionário, GHE, itens, sem solicitante) e TOKEN_ATENDIMENTO_ENCERRADO (PEDIDO_ENVIADO) na mesma transação, sem CPF, matrícula, token, hash do token nem credencial; a lateral liga pedido, tablet e atendimento', async () => {
      const c = await montar({ funcionario: { nome: 'Rastreável Silva Souza' } });
      const antesCriada = (await a.auditorias('SOLICITACAO_EPI_CRIADA')).length; const antesFim = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).length;
      const r = await enviar(c, [a.item(c.unico, { quantidade: 2 })]);
      assert.equal(r.status, 201, aviso(r));
      const [sol] = await a.solicitacoesDe(c.f.id);
      const criada = (await a.auditorias('SOLICITACAO_EPI_CRIADA')).slice(antesCriada);
      assert.equal(criada.length, 1);
      assert.deepEqual([criada[0].usuario_id, criada[0].empresa_id, criada[0].referencia], [null, A(), String(sol.id)]);
      assert.deepEqual([criada[0].contexto.origemSolicitacao, criada[0].contexto.funcionarioId, criada[0].contexto.gheId, criada[0].contexto.solicitanteId ?? null], ['AUTOATENDIMENTO', c.f.id, c.gheId, null]);
      const fim = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).slice(antesFim);
      assert.deepEqual(fim.map((l) => l.contexto), [{ motivo: 'PEDIDO_ENVIADO', dispositivoId: c.t.id, funcionarioId: c.f.id }]);
      const segredos = [c.f.cpf, c.f.matricula, 'Rastreável', 'Souza', c.token, hashTokenSessao(c.token), sha256(c.token), c.t.credencial, hashTokenSessao(c.t.credencial)];
      const texto = JSON.stringify(await a.todaAuditoria(A()));
      for (const s of segredos) assert.equal(texto.includes(s), false, `vazou: ${String(s).slice(0, 8)}`);
      assert.deepEqual([(await a.lateralDe(sol.id)).dispositivo_id, (await a.lateralDe(sol.id)).atendimento_id], [c.t.id, String(c.atendimentoId)]);
    });
  });

  // ───────────────────────── atendimentos não finalizados e carrinho ─────────────────────────
  describe('atendimentos não finalizados e carrinho', () => {
    test('F30 — atendimento INICIADO e ABANDONADO sem pedido: nenhuma solicitação nem lateral nasce; o registro fecha por INATIVIDADE (ou SAIDA/SUBSTITUIDO, conforme a causa) e a consulta de resultado por qualquer chave é 404/401, nunca sucesso', async () => {
      const antes = await a.fotografia();
      const c = await montar();
      const catalogo = await a.catalogo(app, c.t, c.token);
      assert.equal(catalogo.status, 200, aviso(catalogo));
      await forcarRestante(c.atendimentoId, -10);
      assert.deepEqual([(await a.consultar(app, c.t, c.token)).status], [401]);
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'INATIVIDADE');
      const saida = await montar();
      assert.equal((await a.encerrarAtendimento(app, saida.t, saida.token)).status, 200);
      assert.equal((await atendimentoDe(saida)).motivo_encerramento, 'SAIDA');
      const depois = await a.fotografia();
      assert.deepEqual([depois.solicitacoes, depois.autoatendimento, depois.itens], [antes.solicitacoes, antes.autoatendimento, antes.itens]);
      const sem = await a.resultado(app, saida.t, saida.token, a.chave());
      assert.ok([401, 404].includes(sem.status) && sem.body.codigo !== 'ROTA_NAO_ENCONTRADA', aviso(sem));
    });

    test('F31 — CARRINHO abandonado não vira solicitação: tentativas recusadas (validação, material não autorizado, tamanho inválido), consultas de catálogo e de resultado não criam pedido, não consomem número e deixam o atendimento aberto e utilizável', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      await a.catalogo(app, c.t, c.token);
      await enviar(c, [a.item(c.comGrade, { tamanho: 'XG' })]);
      await enviar(c, [a.item(await a.material(A(), { nome: 'F31 fora' }))]);
      await enviar(c, [a.item(c.unico, { quantidade: 0 })]);
      const sem = await a.resultado(app, c.t, c.token, a.chave());
      assert.equal(sem.status, 404, aviso(sem));
      assert.deepEqual(await a.fotografia(), antes);
      assert.equal((await a.consultar(app, c.t, c.token)).status, 200, 'o atendimento segue aberto');
      assert.equal((await enviar(c, [a.item(c.unico)])).status, 201, 'e ainda aceita o carrinho certo');
    });

    test('F32 — o carrinho de um funcionário anterior NÃO é reutilizado: a chave do pedido do funcionário A não devolve nem conflita-vaza para o B; o B com a mesma chave e o mesmo carrinho é um pedido DISTINTO recusado como conflito, a consulta do resultado é 404 e nada de A aparece na resposta de B', async () => {
      const c = await montar({ funcionario: { nome: 'Funcionario Anterior' } });
      const payload = a.corpo([a.item(c.unico, { quantidade: 5 })]);
      const doA = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(doA.status, 201, aviso(doA));
      const b = await a.funcionarioNoGhe(A(), c.ghe);
      const abertoB = await a.identificar(app, c.t.credencial, { tipo: 'CPF', valor: b.cpf });
      assert.equal(abertoB.status, 201, aviso(abertoB));
      const tokenB = cookieDoAtendimentoNaResposta(abertoB).valor;
      const mesmaChave = await a.finalizar(app, c.t, tokenB, payload);
      assert.deepEqual([mesmaChave.status, mesmaChave.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO'], aviso(mesmaChave));
      assert.equal(JSON.stringify(mesmaChave.body).includes(String(doA.body.pedido.numero)) && mesmaChave.body.pedido !== undefined, false);
      const consulta = await a.resultado(app, c.t, tokenB, payload.chaveIdempotencia);
      assert.deepEqual([consulta.status, consulta.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], aviso(consulta));
      assert.equal((await a.solicitacoesDe(b.id)).length, 0);
      assert.equal((await a.finalizar(app, c.t, tokenB, a.corpo([a.item(c.unico)]))).status, 201, 'o B registra o seu com a sua chave');
    });

    test('F33 — CONSULTAS automáticas não renovam os 60 s: o resultado por chave, o catálogo e as finalizações RECUSADAS deixam expira_em intocado; só a atividade da Etapa D renova', async () => {
      const c = await montar();
      await forcarRestante(c.atendimentoId, 20);
      const antes = JSON.stringify(await atendimentoDe(c));
      for (let i = 0; i < 6; i += 1) {
        assert.equal((await a.catalogo(app, c.t, c.token)).status, 200);
        const consulta = await a.resultado(app, c.t, c.token, a.chave());
        assert.equal(consulta.status, 404);
        assert.deepEqual(lerSetCookie(consulta), [], 'a consulta de resultado nunca emite nem renova cookie');
        assert.equal((await enviar(c, [a.item(c.unico, { quantidade: 0 })])).status, 400);
        assert.equal((await enviar(c, [a.item(c.comGrade, { tamanho: 'XG' })])).status, 400);
      }
      assert.equal(JSON.stringify(await atendimentoDe(c)), antes, 'nenhuma consulta nem recusa renovou o prazo');
      const atividade = await a.prorrogar(app, c.t, c.token);
      assert.equal(atividade.status, 200, aviso(atividade));
      assert.ok(atividade.body.atendimento.restanteSegundos > 55, 'só a atividade renova');
    });
  });

  // ───────────────────────── integração com a 12G-6 e confirmação ─────────────────────────
  describe('integração com os serviços reais e confirmação', () => {
    test('F34 — INTEGRAÇÃO com os serviços reais da 12G-6: o pedido do tablet aparece na fila da SST, é decidido pelo serviço real SEM estoque (AGUARDANDO_ESTOQUE), a reposição é reconhecida (PRONTA_PARA_ENTREGA) e só a entrega física (fora desta etapa) baixaria o estoque e atualizaria a ficha', async () => {
      const c = await montar();
      const antesDaCriacao = await a.fotografia();
      const r = await enviar(c, [a.item(c.comGrade, { tamanho: 'P', quantidade: 2 }), a.item(c.unico)]);
      assert.equal(r.status, 201, aviso(r));
      const [sol] = await a.solicitacoesDe(c.f.id);
      const fila = await consultaSvc.listarFila(a.ctx.pool, { empresaId: A(), pagina: 1, limite: 100 });
      assert.equal(JSON.stringify(fila).includes(`"numero":${sol.numero}`), true, 'a fila da SST mostra o pedido');
      const itens = await a.itensDe(sol.id);
      const dec = await solicitacaoSvc.decidirSolicitacao(a.ctx.pool, { empresaId: A(), atorId: a.d.sst1, solicitacaoId: sol.id, decisoes: itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO' })) });
      assert.equal(dec.solicitacao.status, 'APROVADA');
      const situacoes = async () => (await solicitacaoSvc.buscarSolicitacao(a.ctx.pool, { empresaId: A(), solicitacaoId: sol.id })).itens.map((i) => i.situacao);
      assert.deepEqual(await situacoes(), ['AGUARDANDO_ESTOQUE', 'AGUARDANDO_ESTOQUE']);
      await criarLote(a.ctx.pool, { empresaId: A(), materialId: c.comGrade, quantidade: 2, tamanho: 'P' });
      assert.deepEqual((await situacoes()).sort(), ['AGUARDANDO_ESTOQUE', 'PRONTA_PARA_ENTREGA']);
      const f = await a.fotografia();
      assert.deepEqual([f.lotesBaixado, f.lotesEntregue, f.entregas, f.fichas], [antesDaCriacao.lotesBaixado, antesDaCriacao.lotesEntregue, antesDaCriacao.entregas, antesDaCriacao.fichas]);
    });

    test('F35 — SUCESSO só depois da PERSISTÊNCIA real: com falha injetada ao gravar os itens a resposta é erro (5xx, nunca 201), nada fica gravado, o número não é consumido, o atendimento segue aberto e o MESMO pedido repetido depois é aceito; e um 201 é sempre visível por outra conexão', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      const instr = a.poolInstrumentado([{ nome: 'itens', casa: /INSERT INTO solicitacoes_epi_itens/, acao: 'falhar' }]);
      const quebrado = a.criarApp({ hops: 0, pool: instr.pool });
      const payload = a.corpo([a.item(c.unico)]);
      const falha = await a.finalizar(quebrado, c.t, c.token, payload);
      assert.ok(falha.status >= 500 && falha.status !== 201, `não pode haver sucesso falso: ${aviso(falha)}`);
      assert.deepEqual(await a.fotografia(), antes);
      assert.equal((await atendimentoDe(c)).encerrado_em, null);
      const certo = await a.finalizar(app, c.t, c.token, payload);
      assert.equal(certo.status, 201, aviso(certo));
      const outraConexao = await a.q('SELECT numero FROM solicitacoes_epi WHERE funcionario_id = $1', [c.f.id]);
      assert.deepEqual(outraConexao.rows.map((l) => l.numero), [certo.body.pedido.numero]);
    });

    test('F36 — RESULTADO DESCONHECIDO sem confirmação falsa: chave que nunca chegou é 404 PEDIDO_NAO_ENCONTRADO; com a finalização EM PROCESSAMENTO (pool instrumentado, sem sleep) a consulta responde 202 EM_PROCESSAMENTO sem bloquear e sem afirmar sucesso; depois do COMMIT responde 200 REGISTRADO', async () => {
      const c = await montar();
      const desconhecida = await a.resultado(app, c.t, c.token, a.chave());
      assert.deepEqual([desconhecida.status, desconhecida.body.codigo], [404, 'PEDIDO_NAO_ENCONTRADO'], aviso(desconhecida));
      const instr = a.poolInstrumentado([{ nome: 'meio', casa: /INSERT INTO solicitacoes_epi_itens/, acao: 'pausar' }]);
      const lenta = a.criarApp({ hops: 0, pool: instr.pool });
      const payload = a.corpo([a.item(c.unico)]);
      const emCurso = a.finalizar(lenta, c.t, c.token, payload).then((x) => x);
      try {
        await Promise.race([instr.pausado('meio'), emCurso.then((x) => assert.fail(`a finalização terminou sem passar pelo meio: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('a finalização não chegou ao meio da transação')), LIMITE_DE_SEGURANCA_MS))]);
        const consulta = await a.resultado(app, c.t, c.token, payload.chaveIdempotencia);
        assert.equal(consulta.status, 202, aviso(consulta));
        assert.deepEqual(consulta.body.pedido, { estado: 'EM_PROCESSAMENTO' });
        assert.deepEqual(lerSetCookie(consulta), [], 'nem o 202 emite ou renova cookie');
        assert.equal(JSON.stringify(consulta.body).includes('REGISTRADO'), false);
      } finally { instr.liberar('meio'); }
      const final = await emCurso;
      assert.equal(final.status, 201, aviso(final));
      const depois = await a.resultado(app, c.t, c.token, payload.chaveIdempotencia);
      assert.deepEqual([depois.status, depois.body.pedido.estado, depois.body.pedido.numero], [200, 'REGISTRADO', final.body.pedido.numero]);
    });

    /** Pausa a finalização dentro da transação, ANTES da trava do tablet (a autenticação do middleware já passou), muda o estado e a libera. */
    async function mudarDuranteAFinalizacao(c, alterar, restaurar = async () => {}) {
      const instr = a.poolInstrumentado([{ nome: 'tablet', casa: /FOR UPDATE OF d/, acao: 'pausar' }]);
      const lenta = a.criarApp({ hops: 0, pool: instr.pool });
      const resposta = a.finalizar(lenta, c.t, c.token, a.corpo([a.item(c.unico)])).then((x) => x);
      try {
        await Promise.race([instr.pausado('tablet'), resposta.then((x) => assert.fail(`terminou sem passar pela trava do tablet: ${aviso(x)}`)), new Promise((_, rej) => setTimeout(() => rej(new Error('a finalização não chegou à trava do tablet')), LIMITE_DE_SEGURANCA_MS))]);
        await alterar();
      } finally { instr.liberar('tablet'); }
      const r = await resposta;
      await restaurar();
      return r;
    }

    test('F39 — a autorização do TABLET é reconferida SOB A TRAVA (pool instrumentado, sem sleep): tablet revogado, empresa inativada ou credencial rotacionada depois da autenticação do middleware e antes do aceite recusam a finalização (401 DISPOSITIVO_NAO_AUTORIZADO) e nada é criado', async () => {
      const revogado = await montar();
      const antes = await a.fotografia();
      const r1 = await mudarDuranteAFinalizacao(revogado, async () => {
        assert.equal((await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${revogado.t.id}/revogar`)).status, 200);
      });
      assert.deepEqual([r1.status, r1.body.codigo], NAO_AUTORIZADO, `revogado: ${aviso(r1)}`);

      const inativa = await montar();
      const r2 = await mudarDuranteAFinalizacao(inativa, () => a.q('UPDATE empresas SET ativo = false WHERE id = $1', [A()]), () => a.q('UPDATE empresas SET ativo = true WHERE id = $1', [A()]));
      assert.deepEqual([r2.status, r2.body.codigo], NAO_AUTORIZADO, `empresa inativa: ${aviso(r2)}`);

      const rotacionada = await montar();
      const r3 = await mudarDuranteAFinalizacao(rotacionada, () => a.q("UPDATE token_dispositivos SET credencial_hash = $2, credencial_anterior_hash = NULL WHERE id = $1", [rotacionada.t.id, 'a'.repeat(64)]));
      assert.deepEqual([r3.status, r3.body.codigo], NAO_AUTORIZADO, `credencial rotacionada: ${aviso(r3)}`);
      assert.deepEqual(await a.fotografia(), antes, 'nenhuma dessas recusas criou algo');
    });

    test('F40 — o ATENDIMENTO é travado no ponto de aceite: enquanto outra transação o segura, a finalização ESPERA; se ele foi encerrado nesse intervalo a resposta é 401 ATENDIMENTO_INVALIDO (nunca 500) e nada é criado', async () => {
      const c = await montar();
      const antes = await a.fotografia();
      const concorrente = await a.ctx.pool.connect();
      try {
        await concorrente.query('BEGIN');
        await concorrente.query('SELECT id FROM token_atendimentos WHERE id = $1 FOR UPDATE', [c.atendimentoId]);
        const pid = (await concorrente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        let terminou = false;
        const resposta = enviar(c, [a.item(c.unico)]).then((r) => { terminou = true; return r; });
        const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
        while (!terminou && (await esperando(pid)) === 0) {
          if (Date.now() > prazo) assert.fail('a finalização não chegou a esperar a trava do atendimento');
          await new Promise((resolver) => setImmediate(resolver));
        }
        assert.equal(terminou, false, 'a finalização deveria esperar o atendimento');
        await concorrente.query("UPDATE token_atendimentos SET encerrado_em = clock_timestamp(), motivo_encerramento = 'SAIDA' WHERE id = $1", [c.atendimentoId]);
        await concorrente.query('COMMIT');
        const r = await resposta;
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      } finally { await concorrente.query('ROLLBACK').catch(() => {}); concorrente.release(); }
      assert.deepEqual(await a.fotografia(), antes);
    });

    test('F41 — o encerramento do pedido só atua sobre atendimento ABERTO: sobre um já encerrado devolve false e não troca o motivo', async () => {
      const pedidoRepo = require('../../src/repositories/token-pedido.repository');
      const c = await montar();
      assert.equal(await pedidoRepo.encerrarComPedido(a.ctx.pool, { id: c.atendimentoId }), true);
      assert.equal((await atendimentoDe(c)).motivo_encerramento, 'PEDIDO_ENVIADO');
      const d = await montar();
      await a.q("UPDATE token_atendimentos SET encerrado_em = clock_timestamp(), motivo_encerramento = 'SAIDA' WHERE id = $1", [d.atendimentoId]);
      assert.equal(await pedidoRepo.encerrarComPedido(a.ctx.pool, { id: d.atendimentoId }), false);
      assert.equal((await atendimentoDe(d)).motivo_encerramento, 'SAIDA');
    });

    test('F42 — a recuperação e a repetição pertencem ao ATENDIMENTO, ao TABLET e à EMPRESA: o cookie de um pedido já gravado, apresentado por outro tablet (mesma ou outra empresa), não devolve o resultado nem repete o pedido; um atendimento de outro funcionário no mesmo tablet também não lê a chave alheia', async () => {
      const c = await montar();
      const payload = a.corpo([a.item(c.unico)]);
      assert.equal((await a.finalizar(app, c.t, c.token, payload)).status, 201);
      const antes = await a.fotografia();

      const outroTablet = await a.tabletNovo(A());
      const r1 = await a.resultado(app, outroTablet, c.token, payload.chaveIdempotencia);
      assert.deepEqual([r1.status, r1.body.codigo], ATENDIMENTO_INVALIDO, `outro tablet (resultado): ${aviso(r1)}`);
      const r2 = await a.finalizar(app, outroTablet, c.token, payload);
      assert.deepEqual([r2.status, r2.body.codigo], ATENDIMENTO_INVALIDO, `outro tablet (repetição): ${aviso(r2)}`);

      await a.redes({ A: a.redeDeTeste.A, B: a.redeDeTeste.A }); // a rede da empresa B autoriza o mesmo IP: a recusa abaixo vem do atendimento, não da rede (o beforeEach restaura)
      const tabletDaOutraEmpresa = await a.tabletNovo(a.d.empresaB);
      const r3 = await a.resultado(app, tabletDaOutraEmpresa, c.token, payload.chaveIdempotencia);
      assert.deepEqual([r3.status, r3.body.codigo], ATENDIMENTO_INVALIDO, `outra empresa (resultado): ${aviso(r3)}`);
      const r4 = await a.finalizar(app, tabletDaOutraEmpresa, c.token, payload);
      assert.deepEqual([r4.status, r4.body.codigo], ATENDIMENTO_INVALIDO, `outra empresa (repetição): ${aviso(r4)}`);

      // Mesmo tablet, outro funcionário que TAMBÉM já fez o seu pedido: a chave do primeiro continua inexistente para ele.
      const segundo = await a.cenario(app, { gheId: c.gheId, tablet: c.t });
      assert.equal((await a.finalizar(app, c.t, segundo.token, a.corpo([a.item(c.unico)]))).status, 201);
      const r5 = await a.resultado(app, c.t, segundo.token, payload.chaveIdempotencia);
      assert.deepEqual([r5.status, r5.body.codigo], ATENDIMENTO_INVALIDO, aviso(r5)); // o atendimento do segundo já está encerrado por PEDIDO_ENVIADO e não é o dono da chave
      const solicitacoes = (await a.fotografia()).solicitacoes - antes.solicitacoes;
      assert.equal(solicitacoes, 1, 'só o pedido do segundo funcionário foi criado depois');
    });

    test('F43 — material AUTORIZADO pelo GHE mas ainda NÃO CLASSIFICADO quanto a tamanho (exige_tamanho nulo) não é oferecido nem aceito: 409 ITEM_NAO_AUTORIZADO e nada é criado', async () => {
      const c = await montar();
      const naoClassificado = await a.material(A(), { nome: 'F sem classificação', exigeTamanho: null });
      await a.vincularMaterial(A(), c.ghe, naoClassificado);
      const antes = await a.fotografia();
      const r = await enviar(c, [a.item(naoClassificado)]);
      assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO_ITEM, aviso(r));
      await exigirNadaCriado(c, antes, 'F43');
    });

    test('F44 — o RESULTADO só vale para atendimento vigente e funcionário elegível: vencido ou funcionário inativado é 401 ATENDIMENTO_INVALIDO, nunca 404 nem sucesso', async () => {
      const vencido = await montar();
      await forcarRestante(vencido.atendimentoId, -10);
      const r1 = await a.resultado(app, vencido.t, vencido.token, a.chave());
      assert.deepEqual([r1.status, r1.body.codigo], ATENDIMENTO_INVALIDO, `vencido: ${aviso(r1)}`);
      const inativado = await montar();
      await a.q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [inativado.f.id]);
      const r2 = await a.resultado(app, inativado.t, inativado.token, a.chave());
      assert.deepEqual([r2.status, r2.body.codigo], ATENDIMENTO_INVALIDO, `inativado: ${aviso(r2)}`);
    });

    test('F37 — EQUIVALÊNCIA com o serviço REAL da 12G: para o mesmo GHE e material autorizado, quantidade e classificação de tamanho têm o mesmo veredito (aceito ou código) no Totem e no serviço de solicitação', async () => {
      const casos = [
        { rotulo: 'ok único', material: 'unico', item: { quantidade: 1 }, aceita: true },
        { rotulo: 'quantidade 500', material: 'unico', item: { quantidade: 500 }, aceita: true },
        { rotulo: 'quantidade 0', material: 'unico', item: { quantidade: 0 }, aceita: false },
        { rotulo: 'quantidade negativa', material: 'unico', item: { quantidade: -1 }, aceita: false },
        { rotulo: 'quantidade fracionária', material: 'unico', item: { quantidade: 1.5 }, aceita: false },
        { rotulo: 'único com tamanho', material: 'unico', item: { tamanho: 'M' }, aceita: false, codigo: 'TAMANHO_NAO_SE_APLICA' },
        { rotulo: 'grade ok', material: 'comGrade', item: { tamanho: 'P' }, aceita: true },
        { rotulo: 'grade sem tamanho', material: 'comGrade', item: {}, aceita: false, codigo: 'TAMANHO_OBRIGATORIO' },
        { rotulo: 'fora da grade', material: 'comGrade', item: { tamanho: 'XG' }, aceita: false, codigo: 'TAMANHO_FORA_DA_GRADE' },
      ];
      for (const caso of casos) {
        const c = await montar();
        const materialId = c[caso.material];
        const item = a.item(materialId, caso.item);
        const totem = await enviar(c, [item]);
        const outro = await a.funcionarioNoGhe(A(), c.gheId);
        let doze = { aceita: true };
        try {
          await solicitacaoSvc.criarSolicitacao(a.ctx.pool, {
            empresaId: A(), atorId: a.d.master, funcionarioId: outro.id, itens: [{ materialId, tamanho: item.tamanho, quantidade: item.quantidade, motivo: item.motivo }], chaveIdempotencia: a.chave(),
          });
        } catch (erro) {
          doze = { aceita: false, codigo: erro.detalhes?.[0]?.codigo ?? erro.codigo };
        }
        assert.equal(totem.status === 201, doze.aceita, `${caso.rotulo}: Totem ${aviso(totem)} × 12G ${JSON.stringify(doze)}`);
        assert.equal(doze.aceita, caso.aceita, `${caso.rotulo}: veredito da 12G`);
        if (!caso.aceita && caso.codigo) {
          assert.equal(doze.codigo, caso.codigo, `${caso.rotulo}: código da 12G`);
          assert.equal(totem.body.detalhes?.[0]?.codigo ?? totem.body.codigo, caso.codigo, `${caso.rotulo}: código do Totem`);
        }
      }
    });

    test('F38 — GUARDA dos motivos: os três motivos do Totem existem no conjunto aceito pela 12G (o Totem restringe, nunca cria motivo); ADMISSAO e OUTRO ficam de fora do Totem e continuam válidos no canal interno', async () => {
      const { MOTIVOS_DO_TOTEM } = require('../../src/schemas/token-pedido.schema');
      assert.deepEqual([...MOTIVOS_DO_TOTEM].sort(), ['DESGASTE_DANO', 'PERDA_EXTRAVIO', 'SUBSTITUICAO_PRAZO']);
      for (const motivo of MOTIVOS_DO_TOTEM) assert.ok(itemRepo.MOTIVOS.includes(motivo), `${motivo} não existe na 12G`);
      assert.ok(itemRepo.MOTIVOS.includes('ADMISSAO') && itemRepo.MOTIVOS.includes('OUTRO'));
      assert.equal(MOTIVOS_DO_TOTEM.includes('ADMISSAO') || MOTIVOS_DO_TOTEM.includes('OUTRO'), false);
    });
  });
});
