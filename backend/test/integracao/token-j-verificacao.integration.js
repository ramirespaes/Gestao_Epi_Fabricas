'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { REDE_DE_TESTE, LIMIAR_OFFLINE_S, CONFIRMACAO_S, depois, instanteBase, exigirStatus, abrirAmbienteJ } = require('./helpers/token-j');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Atendimento Token — Etapa J, J2a (RED): verificação da comunicação (job externo) e transições QUEDA/RESTABELECIMENTO.
 * PostgreSQL real, schema temporário. O job é chamado como função, com RELÓGIO e SONDA injetados: nenhum sleep, nenhuma rede,
 * nenhum e-mail. Os instantes são relativos a um "T0" no passado; o último contato do tablet é gravado em T0 e cada passagem do
 * job recebe T0 + N segundos.
 *
 * Quatro coisas distintas (D5): (1) estado efetivo (derivado, 180 s), (2) transição confirmada (QUEDA, 90 s adicionais com sonda
 * saudável), (3) alerta enviado (fora do J2a), (4) saúde do monitoramento (sonda). Estes testes NÃO afirmam a causa da ausência.
 *
 * Sequência contratual da QUEDA: (1) primeira observação elegível (silêncio >= 180 s, tablet elegível, sonda saudável): NUNCA confirma,
 * ainda que tardia; (2) nova observação antes de 90 s depois da primeira: não confirma; (3) nova observação 90 s ou mais depois, sem
 * contato novo: confirma UMA vez; (4) heartbeat entre as observações cancela a suspeita; (5) passagem abortada pela sonda não escreve.
 * Nenhum teste substitui isso por "270 s desde o último contato": as sequências E01/E03/E04/E07c/E14 separam as duas observações.
 *
 * Os testes não citam coluna, tabela, cache ou mecanismo de persistência: observam só o comportamento entre passagens. O que depende
 * de decisão pendente está como TODO JUSTIFICADO (DEP-*: DEC-D5-02, DEC-D5-03, DEC-D5-04), nunca como PASS nem como RED válido.
 *
 * Premissa de retorno: verificarComunicacao -> { abortada: boolean, quedas: number }.
 * Razões contratuais válidas de falha: "módulo ainda não implementado: src/services/token-monitoramento.service.js" e
 * "função ainda não implementada: verificarComunicacao" (heartbeat ausente: 404 ROTA_NAO_ENCONTRADA, só nos testes E16/E17).
 */

const SILENCIO_APOS_LIMIAR = LIMIAR_OFFLINE_S + 1; // 181 s: já OFFLINE efetivo, confirmação ainda não possível
const CONFIRMADA = SILENCIO_APOS_LIMIAR + CONFIRMACAO_S + 5; // 276 s: 95 s depois da primeira observação
const REDES = { A: [...REDE_DE_TESTE], B: [...REDE_DE_TESTE] };

describe('Atendimento Token — J2a: verificação da comunicação e transições (PostgreSQL real)', () => {
  let a;
  let app;
  const A = () => a.d.empresaA;
  const B = () => a.d.empresaB;

  before(async () => {
    a = await abrirAmbienteJ();
    app = a.criarApp({ hops: 0 });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => {
    await a.redes(REDES);
    await a.zerarContatos();
  });

  const comoServico = () => exigirModulo('src/services/token-monitoramento.service');
  const linhaDe = (id) => a.linha(id);

  // ───────────── controles (passam já no RED) ─────────────
  describe('controles (devem passar já no RED)', () => {
    test('K1 — fixture: o tablet ativado guarda o último contato exato que o teste define, e o estado registrado é o informado', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      const linha = await linhaDe(t.id);
      assert.equal(linha.ultimo_contato_em.getTime(), t0.getTime());
      assert.equal(linha.comunicacao_registrada, 'ONLINE');
    });

    test('K2 — a tabela de eventos não tem coluna de causa: o evento registra QUE houve queda, nunca POR QUÊ', async () => {
      const colunas = (await a.q("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'token_dispositivo_eventos'")).rows.map((l) => l.column_name);
      assert.ok(colunas.includes('tipo') && colunas.includes('ocorrido_em'));
      assert.equal(colunas.some((c) => /causa|motivo|diagnostico|razao/.test(c)), false, colunas.join(','));
    });
  });

  // ───────────────────────── 180 s: estado efetivo; 90 s: confirmação ─────────────────────────
  describe('180 s mudam o estado efetivo; a QUEDA exige a confirmação adicional de 90 s', () => {
    test('E01 — com 181 s de silêncio o estado efetivo já é OFFLINE, mas NENHUMA transição é persistida na primeira observação', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      const agora = depois(t0, SILENCIO_APOS_LIMIAR);
      const linha = await linhaDe(t.id);
      assert.equal(comoServico().derivarEstado(linha, agora), 'OFFLINE', 'estado efetivo (derivado)');
      await a.job({ agora });
      assert.deepEqual(await a.quedas(t.id), [], 'a QUEDA não pode ser registrada na primeira observação');
      assert.equal((await linhaDe(t.id)).comunicacao_registrada, 'ONLINE', 'o estado registrado não mudou');
    });

    test('E02 — antes de 180 s nada acontece: nem OFFLINE efetivo, nem transição', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      for (const segundos of [60, 120, LIMIAR_OFFLINE_S - 1]) {
        const agora = depois(t0, segundos);
        assert.equal(comoServico().derivarEstado(await linhaDe(t.id), agora), 'ONLINE', `${segundos} s`);
        await a.job({ agora });
      }
      assert.deepEqual(await a.quedas(t.id), []);
    });

    test('E03 — nova observação ANTES dos 90 s adicionais (30 s e 85 s depois da primeira) ainda NÃO registra a QUEDA', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      for (const apos of [30, CONFIRMACAO_S - 5]) {
        await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR + apos) });
        assert.deepEqual(await a.quedas(t.id), [], `${apos} s depois da primeira observação`);
      }
      assert.equal((await linhaDe(t.id)).comunicacao_registrada, 'ONLINE');
    });

    test('E04 — nova observação DEPOIS dos 90 s adicionais (95 s após a primeira): registra UMA QUEDA e passa o estado registrado a OFFLINE', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      const primeira = await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      assert.deepEqual([primeira.abortada, primeira.quedas], [false, 0]);
      const segunda = await a.job({ agora: depois(t0, CONFIRMADA) });
      assert.deepEqual([segunda.abortada, segunda.quedas], [false, 1]);
      const quedas = await a.quedas(t.id);
      assert.equal(quedas.length, 1);
      assert.equal(quedas[0].empresa_id, A());
      assert.equal((await linhaDe(t.id)).comunicacao_registrada, 'OFFLINE');
    });

    test('E05 — passagens seguintes com o tablet ainda mudo não repetem a QUEDA', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      for (const segundos of [SILENCIO_APOS_LIMIAR, CONFIRMADA, CONFIRMADA + 60, CONFIRMADA + 600]) await a.job({ agora: depois(t0, segundos) });
      assert.equal((await a.quedas(t.id)).length, 1);
    });

    test('E06 — jobs concorrentes: na primeira observação nenhuma QUEDA; na confirmação, exatamente UMA (com 2 e com 4 jobs simultâneos)', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await Promise.all(Array.from({ length: 3 }, () => a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) })));
      assert.deepEqual(await a.quedas(t.id), [], 'primeira observação concorrente não confirma');
      await Promise.all([a.job({ agora: depois(t0, CONFIRMADA) }), a.job({ agora: depois(t0, CONFIRMADA) })]);
      assert.equal((await a.quedas(t.id)).length, 1, 'dois jobs');
      const t2 = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await Promise.all(Array.from({ length: 4 }, () => a.job({ agora: depois(t0, CONFIRMADA) })));
      assert.equal((await a.quedas(t2.id)).length, 1, 'quatro jobs');
      assert.equal((await a.quedas(t.id)).length, 1, 'o primeiro tablet segue com uma só');
    });

    test('E07 — heartbeat entre as observações (contato novo) cancela a suspeita anterior: a observação que seria a confirmação não registra QUEDA', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.definirContato(t.id, depois(t0, SILENCIO_APOS_LIMIAR + 40));
      await a.job({ agora: depois(t0, CONFIRMADA) });
      assert.deepEqual(await a.quedas(t.id), []);
      assert.equal((await linhaDe(t.id)).comunicacao_registrada, 'ONLINE');
    });

    test('E07b — o mesmo cancelamento com um heartbeat REAL (rota) entre as observações', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'heartbeat entre as observações');
      await a.job({ agora: depois(t0, CONFIRMADA) });
      assert.deepEqual(await a.quedas(t.id), []);
    });

    test('E07c — depois do cancelamento um NOVO silêncio exige nova primeira observação e novos 90 s: os 200 s desde a suspeita cancelada não contam', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      const novoContato = depois(t0, 200);
      await a.definirContato(t.id, novoContato);
      await a.job({ agora: depois(novoContato, SILENCIO_APOS_LIMIAR) });
      assert.deepEqual(await a.quedas(t.id), [], 'nova primeira observação, mesmo com mais de 90 s desde a suspeita cancelada');
      await a.job({ agora: depois(novoContato, CONFIRMADA) });
      assert.equal((await a.quedas(t.id)).length, 1, 'a confirmação da nova sequência registra a QUEDA');
    });
  });

  // ───────────────────────── quem não entra no monitoramento ─────────────────────────
  describe('tablets fora do monitoramento', () => {
    test('E08 — tablet ativado que nunca comunicou é SEM_COMUNICACAO e nunca gera QUEDA, por mais tempo que passe', async () => {
      const t = await a.ativado(A());
      const agora = depois(instanteBase(), 100000);
      assert.equal(comoServico().derivarEstado(await linhaDe(t.id), agora), 'SEM_COMUNICACAO');
      await a.job({ agora });
      await a.job({ agora: depois(agora, CONFIRMADA) });
      assert.deepEqual(await a.quedas(t.id), []);
    });

    test('E09 — tablet revogado e tablet não ativado, ambos com contato antigo, não geram QUEDA', async () => {
      const t0 = instanteBase();
      const revogado = await a.tabletComContato(A(), t0);
      await a.q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $2, credencial_hash = NULL, credencial_anterior_hash = NULL WHERE id = $1', [revogado.id, a.masterDe(A())]);
      const naoAtivado = await a.dispositivo(A());
      await a.definirContato(naoAtivado.id, t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, CONFIRMADA) });
      assert.deepEqual(await a.quedas(revogado.id), []);
      assert.deepEqual(await a.quedas(naoAtivado.id), []);
      assert.equal(comoServico().derivarEstado(await linhaDe(revogado.id), depois(t0, CONFIRMADA)), 'REVOGADO');
    });
  });

  // ───────────────────────── saúde do monitoramento: sonda ─────────────────────────
  describe('saúde do monitoramento (sonda)', () => {
    test('E10 — sonda falhando: a passagem é ABORTADA, nada é escrito (tablets e eventos idênticos) e nenhuma QUEDA nasce, nem com silêncio enorme', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      const semObservacaoPrevia = await a.fotografiaDoMonitoramento();
      const imediata = await a.job({ agora: depois(t0, 5000), saudavel: false });
      assert.equal(imediata.abortada, true);
      assert.equal(await a.fotografiaDoMonitoramento(), semObservacaoPrevia, 'passagem abortada na primeira vista não escreve');

      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      const antes = await a.fotografiaDoMonitoramento();
      const abortada = await a.job({ agora: depois(t0, CONFIRMADA), saudavel: false });
      assert.equal(abortada.abortada, true);
      assert.equal(await a.fotografiaDoMonitoramento(), antes, 'passagem abortada depois de observação prévia também não escreve eventos');
      assert.deepEqual(await a.quedas(t.id), []);
    });

    test('E20 — vários tablets mudos na mesma empresa: com a sonda saudável cada um tem a sua QUEDA (sem causa registrada); com a sonda falhando nenhum', async () => {
      const t0 = instanteBase();
      const mudos = [];
      for (let i = 0; i < 3; i += 1) mudos.push(await a.tabletComContato(A(), t0));
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, CONFIRMADA) });
      for (const t of mudos) assert.equal((await a.quedas(t.id)).length, 1, `tablet ${t.id}`);

      const outros = [];
      for (let i = 0; i < 3; i += 1) outros.push(await a.tabletComContato(A(), t0));
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR), saudavel: false });
      await a.job({ agora: depois(t0, CONFIRMADA), saudavel: false });
      for (const t of outros) assert.deepEqual(await a.quedas(t.id), [], `tablet ${t.id} com sonda falhando`);
    });
  });

  // ───────────────────────── job parado e retomado ─────────────────────────
  describe('job interrompido e retomado', () => {
    test('E13 — job parado por 30 min: os tablets que continuaram batendo NÃO geram QUEDA quando o job volta', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.definirContato(t.id, depois(t0, 1800));
      await a.job({ agora: depois(t0, 1810) });
      await a.definirContato(t.id, depois(t0, 1850));
      await a.job({ agora: depois(t0, 1860) });
      assert.deepEqual(await a.quedas(t.id), []);
    });

    test('E14 — primeira observação TARDIA (job parado por mais de uma hora, silêncio de 5000 s): ela não confirma sozinha; a observação 95 s depois registra UMA QUEDA', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, 5000) });
      assert.deepEqual(await a.quedas(t.id), [], 'a primeira observação, ainda que tardia, não substitui os 90 s adicionais');
      assert.equal((await linhaDe(t.id)).comunicacao_registrada, 'ONLINE');
      await a.job({ agora: depois(t0, 5000 + CONFIRMACAO_S + 5) });
      assert.equal((await a.quedas(t.id)).length, 1);
      await a.job({ agora: depois(t0, 5000 + 2 * CONFIRMACAO_S + 60) });
      assert.equal((await a.quedas(t.id)).length, 1, 'sem duplicidade nas passagens seguintes');
    });

    test('E21 — retomada depois de indisponibilidade: com uma confirmação pendente, duas passagens abortadas pela sonda e o tablet voltando a bater, a passagem saudável seguinte NÃO registra QUEDA e nada foi escrito pelas abortadas', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      const antes = await a.fotografiaDoMonitoramento();
      for (const segundos of [CONFIRMADA, CONFIRMADA + 120]) {
        const abortada = await a.job({ agora: depois(t0, segundos), saudavel: false });
        assert.equal(abortada.abortada, true, `passagem em ${segundos} s`);
      }
      assert.equal(await a.fotografiaDoMonitoramento(), antes, 'as passagens abortadas não escrevem eventos nem contato');
      await a.definirContato(t.id, depois(t0, CONFIRMADA + 150));
      await a.job({ agora: depois(t0, CONFIRMADA + 160) });
      await a.job({ agora: depois(t0, CONFIRMADA + 160 + CONFIRMACAO_S + 10) });
      assert.deepEqual(await a.quedas(t.id), []);
    });
  });

  // ───────────────────────── isolamento e efeitos ─────────────────────────
  describe('isolamento e efeitos', () => {
    test('E15 — cada QUEDA pertence à empresa do próprio tablet; tablet saudável não gera QUEDA; empresas não se misturam', async () => {
      const t0 = instanteBase();
      const mudoA = await a.tabletComContato(A(), t0);
      const saudavelA = await a.tabletComContato(A(), depois(t0, 170));
      const mudoB = await a.tabletComContato(B(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, CONFIRMADA) });
      const quedaA = await a.quedas(mudoA.id);
      const quedaB = await a.quedas(mudoB.id);
      assert.deepEqual([quedaA.length, quedaB.length], [1, 1]);
      assert.equal(quedaA[0].empresa_id, A());
      assert.equal(quedaB[0].empresa_id, B());
      assert.deepEqual(await a.quedas(saudavelA.id), []);
      const eventosDeA = await a.todosEventos(A());
      assert.equal(eventosDeA.some((e) => e.dispositivo_id === mudoB.id), false);
    });

    test('E18 — a passagem não toca atendimentos, funcionários, pedidos, estoque, entregas, fichas nem sessões', async () => {
      const t0 = instanteBase();
      const outro = await a.tabletNovo(A(), 1);
      await a.cenario(app, { tablet: outro });
      await a.zerarContatos();
      await a.tabletComContato(A(), t0);
      const antes = await a.fotografiaSegura();
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, CONFIRMADA) });
      assert.deepEqual(await a.fotografiaSegura(), antes);
    });
  });

  // ───────────────────────── ciclo completo com o heartbeat ─────────────────────────
  describe('ciclo QUEDA → RESTABELECIMENTO → QUEDA', () => {
    async function derrubar(t, t0) {
      await a.definirContato(t.id, t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, CONFIRMADA) });
    }

    test('E16 — o RESTABELECIMENTO é feito pelo heartbeat, sem o job, uma única vez; passagens posteriores com contato recente não geram nova QUEDA', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await derrubar(t, t0);
      assert.deepEqual(await a.tiposDeTransicao(t.id), ['QUEDA']);
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'heartbeat de volta');
      assert.deepEqual(await a.tiposDeTransicao(t.id), ['QUEDA', 'RESTABELECIMENTO']);
      await a.job({ agora: depois(t0, CONFIRMADA + 400) });
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'segunda batida');
      assert.deepEqual(await a.tiposDeTransicao(t.id), ['QUEDA', 'RESTABELECIMENTO']);
      assert.equal((await linhaDe(t.id)).comunicacao_registrada, 'ONLINE');
    });

    test('E17 — um segundo silêncio depois do restabelecimento gera uma nova QUEDA, na ordem QUEDA, RESTABELECIMENTO, QUEDA', async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await derrubar(t, t0);
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'heartbeat de volta');
      const t1 = depois(t0, 1800);
      await derrubar(t, t1);
      assert.deepEqual(await a.tiposDeTransicao(t.id), ['QUEDA', 'RESTABELECIMENTO', 'QUEDA']);
    });
  });

  // ───────────────────────── TODO JUSTIFICADO: decisão contratual pendente (nunca PASS, nunca RED) ─────────────────────────
  describe('TODO JUSTIFICADO — dependentes de decisão sobre recuperação do estado de suspeita e duração', () => {
    test('DEP-E01 — suspeita pendente antiga demais (job parado por muito tempo) com o tablet ainda mudo: a primeira passagem após a retomada confirma ou recomeça?', {
      todo: 'DECISÃO PENDENTE DEC-D5-02 (suspeita antiga): o contrato exige primeira observação elegível + 90 s, mas não define o prazo máximo de validade de uma suspeita. EXPECTATIVA A DEFINIR: recomeçar a sequência (hipótese deste teste) ou confirmar na primeira passagem após a retomada.',
    }, async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR + 3000) });
      assert.deepEqual(await a.quedas(t.id), [], 'a passagem após a longa interrupção recomeça a sequência');
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR + 3000 + CONFIRMACAO_S + 5) });
      assert.equal((await a.quedas(t.id)).length, 1);
    });

    test('DEP-E02 — falha da sonda durante uma confirmação pendente: a suspeita é preservada ou invalidada?', {
      todo: 'DECISÃO PENDENTE DEC-D5-03 (sonda × suspeita pendente): o contrato fixa que a passagem abortada não escreve QUEDA (E10), mas não diz se a suspeita anterior sobrevive. EXPECTATIVA A DEFINIR: invalidar e recomeçar (hipótese deste teste) ou preservar e confirmar na primeira passagem saudável.',
    }, async () => {
      const t0 = instanteBase();
      const t = await a.tabletComContato(A(), t0);
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR) });
      await a.job({ agora: depois(t0, SILENCIO_APOS_LIMIAR + 50), saudavel: false });
      await a.job({ agora: depois(t0, CONFIRMADA) });
      assert.deepEqual(await a.quedas(t.id), [], 'a primeira passagem saudável depois da falha não confirma');
      await a.job({ agora: depois(t0, CONFIRMADA + CONFIRMACAO_S + 5) });
      assert.equal((await a.quedas(t.id)).length, 1);
    });

    test('DEP-E03 — duração do RESTABELECIMENTO: silêncio real (último contato anterior) ou tempo desde a QUEDA registrada?', {
      todo: 'DECISÃO PENDENTE DEC-D5-04 (origem da duração): o contrato aprovado não fixa de onde parte a duração. EXPECTATIVA A DEFINIR: silêncio real, 1000 s no cenário (hipótese deste teste), ou tempo desde a QUEDA, 700 s. O RED firme (H13) só exige >= 700.',
    }, async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '1000 seconds', comunicacao_registrada = 'OFFLINE' WHERE id = $1", [t.id]);
      await a.q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo, ocorrido_em) VALUES ($1, $2, 'QUEDA', now() - interval '700 seconds')", [A(), t.id]);
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'heartbeat de volta');
      const [restabelecimento] = await a.restabelecimentos(t.id);
      assert.ok(restabelecimento.duracao_segundos >= 1000);
    });
  });
});
