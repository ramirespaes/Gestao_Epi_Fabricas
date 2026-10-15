'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { HEARTBEAT, REDE_DE_TESTE, exigirStatus, abrirAmbienteJ } = require('./helpers/token-j');
const { cookieDoAtendimentoNaResposta } = require('./helpers/token-atendimento');
const { cookieDoTabletNaResposta, cookieDoTablet, varrer, ORIGEM, CAMINHO_TABLET } = require('./helpers/token-tablet');
const { gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa J, J2a (RED): o heartbeat do tablet. PostgreSQL real, schema temporário, todas as migrations.
 *
 * Contrato: POST /api/atendimento-token/tablet/heartbeat, só o cookie do tablet, corpo vazio estrito, 200 { status: 'ok' }, sob a
 * autenticação existente do tablet (rede e rotação da Etapa C inalteradas). Atualiza o último contato de forma controlada; não
 * toca o atendimento do funcionário; funciona sem atendimento. A cadência de 60 s com jitter é do cliente (J2b) e não é testada aqui.
 *
 * Razão contratual esperada dos testes H: resposta 404 ROTA_NAO_ENCONTRADA no caminho do heartbeat (rota ainda inexistente).
 * Os controles K usam só o que já existe e passam já no RED. A janela mínima de escrita do contato NÃO está aprovada: o teste firme
 * só exige que batida imediata não regrave e que batida com 50 s de idade regrave; o valor intermediário é o TODO DEP-H01 (DEC-J2A-01).
 */

const ESTADO = `${CAMINHO_TABLET}/estado`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];
const REDES_PADRAO = { A: [...REDE_DE_TESTE], B: [] };

describe('Atendimento Token — J2a: heartbeat do tablet (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;
  const A = () => a.d.empresaA;
  const B = () => a.d.empresaB;

  before(async () => {
    a = await abrirAmbienteJ();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(REDES_PADRAO); });

  const recente = async (id) => (await a.q('SELECT abs(extract(epoch FROM now() - ultimo_contato_em)) < 10 AS ok FROM token_dispositivos WHERE id = $1', [id])).rows[0].ok;
  const forcarRestante = (id, segundos) => a.q(
    "UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() + make_interval(secs => $2::int) WHERE id = $1", [id, segundos],
  );
  const eventosDo = (id) => a.contagem('SELECT count(*)::int AS n FROM token_dispositivo_eventos WHERE dispositivo_id = $1', [id]);

  // ───────────── controles (usam só o que já existe; passam já no RED) ─────────────
  describe('controles (devem passar já no RED)', () => {
    test('K1 — D4: as rotas existentes do tablet (estado, atendimento, atividade) NÃO atualizam o último contato; só o heartbeat atualizará', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const estado = await a.comoTablet(app, t.credencial).get(ESTADO);
      assert.equal(estado.status, 200, JSON.stringify(estado.body));
      const f = await a.funcionario(A());
      const aberto = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
      assert.equal(aberto.status, 201, JSON.stringify(aberto.body));
      const token = cookieDoAtendimentoNaResposta(aberto).valor;
      assert.equal((await a.consultar(app, t, token)).status, 200);
      assert.equal((await a.prorrogar(app, t, token)).status, 200);
      const linha = await a.linha(t.id);
      assert.equal(linha.ultimo_contato_em, null);
      assert.equal(linha.comunicacao_registrada, null);
    });

    test('K2 — o banco aceita as fixtures de transição usadas nestes testes (QUEDA, RESTABELECIMENTO com duração) e mantém os eventos append-only', async () => {
      const t = await a.ativado(A());
      await a.q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo) VALUES ($1, $2, 'QUEDA')", [A(), t.id]);
      await a.q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo, duracao_segundos) VALUES ($1, $2, 'RESTABELECIMENTO', 5)", [A(), t.id]);
      await assert.rejects(() => a.q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo) VALUES ($1, $2, 'RESTABELECIMENTO')", [A(), t.id]));
      await assert.rejects(() => a.q("UPDATE token_dispositivo_eventos SET tipo = 'QUEDA' WHERE dispositivo_id = $1", [t.id]));
      assert.deepEqual(await a.tiposDeTransicao(t.id), ['QUEDA', 'RESTABELECIMENTO']);
    });

    test('K3 — o tablet recém-ativado nasce sem contato nem comunicação registrada, e a rota existente de estado segue respondendo igual', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const linha = await a.linha(t.id);
      assert.deepEqual([linha.ultimo_contato_em, linha.comunicacao_registrada], [null, null]);
      const r = await a.comoTablet(app, t.credencial).get(ESTADO);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body).sort(), ['dispositivo', 'status']);
    });
  });

  // ───────────────────────── registro do contato ─────────────────────────
  describe('registro do último contato', () => {
    test('H01 — tablet válido, sem atendimento nenhum: 200 { status: ok }, grava o último contato, não emite cookie, não cria atendimento nem evento nem auditoria', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const auditoriaAntes = await a.contagem('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1', [A()]);
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, 200, 'heartbeat válido');
      assert.deepEqual(r.body, { status: 'ok' });
      assert.equal(cookieDoTabletNaResposta(r), null, 'sem rotação devida não há novo cookie');
      assert.equal(await recente(t.id), true, 'último contato gravado');
      assert.equal(await a.contagem('SELECT count(*)::int AS n FROM token_atendimentos WHERE dispositivo_id = $1', [t.id]), 0);
      assert.equal(await eventosDo(t.id), 0, 'o primeiro contato não é queda nem restabelecimento');
      assert.equal(await a.contagem('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1', [A()]), auditoriaAntes, 'sem auditoria por batida');
    });

    test('H03 — a escrita é controlada: batida imediata não regrava a linha; batida com 50 s de idade (abaixo da menor cadência, 54 s) regrava', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'primeira batida');
      const c1 = await a.contatoDe(t.id);
      assert.ok(c1.ultimo_contato_em instanceof Date);
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'batida imediata');
      const c2 = await a.contatoDe(t.id);
      assert.equal(c2.versao, c1.versao, 'batida imediata não pode regravar');
      assert.equal(c2.ultimo_contato_em.getTime(), c1.ultimo_contato_em.getTime());

      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '50 seconds' WHERE id = $1", [t.id]);
      const c5 = await a.contatoDe(t.id);
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'batida 50 s depois');
      const c6 = await a.contatoDe(t.id);
      assert.notEqual(c6.versao, c5.versao, 'com 50 s de idade regrava');
      assert.ok(c6.ultimo_contato_em.getTime() > c5.ultimo_contato_em.getTime());
    });

    test('DEP-H01 — janela mínima de escrita do contato: uma batida com o contato de 20 s de idade regrava a linha?', {
      todo: 'DECISÃO PENDENTE DEC-J2A-01 (janela mínima de escrita): "atualização controlada" está aprovada, mas o valor da janela não. EXPECTATIVA A DEFINIR: janela entre 20 s e 50 s (hipótese deste teste: ainda não regrava com 20 s). O RED firme só exige que batida imediata não regrave e que batida com 50 s de idade regrave (a menor cadência é 54 s).',
    }, async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '20 seconds' WHERE id = $1", [t.id]);
      const antes = await a.contatoDe(t.id);
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'batida 20 s depois');
      assert.equal((await a.contatoDe(t.id)).versao, antes.versao);
    });

    test('H04 — dez batidas simultâneas do mesmo tablet: todas 200, a linha termina com contato recente e nenhum evento nasce', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '1 hour', comunicacao_registrada = 'ONLINE' WHERE id = $1", [t.id]);
      const respostas = await Promise.all(Array.from({ length: 10 }, () => a.heartbeat(app, t.credencial)));
      respostas.forEach((r, i) => exigirStatus(r, 200, `batida simultânea ${i + 1}`));
      assert.equal(await recente(t.id), true);
      assert.equal(await eventosDo(t.id), 0);
      assert.equal(respostas.filter((r) => cookieDoTabletNaResposta(r) !== null).length, 0);
    });
  });

  // ───────────────────────── autenticação, revogação e rede ─────────────────────────
  describe('autenticação existente do tablet', () => {
    test('H05 — credencial ausente, malformada, desconhecida, duplicada ou fora do cookie: a MESMA 401, sem Set-Cookie e sem gravar contato', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const cabecalho = (extra) => request(app).post(HEARTBEAT).set('Origin', ORIGEM).set(extra).send({});
      const variantes = [
        ['sem cookie', () => request(app).post(HEARTBEAT).set('Origin', ORIGEM).send({})],
        ['cookie lixo', () => cabecalho({ Cookie: 'gepi_tablet=abc' })],
        ['canônica desconhecida', () => cabecalho({ Cookie: cookieDoTablet(gerarTokenSessao()) })],
        ['cookie duplicado', () => cabecalho({ Cookie: `${cookieDoTablet(t.credencial)}; ${cookieDoTablet(gerarTokenSessao())}` })],
        ['só Authorization Bearer', () => cabecalho({ Authorization: `Bearer ${t.credencial}` })],
        ['só cabeçalho X-Credencial', () => cabecalho({ 'X-Credencial': t.credencial })],
      ];
      const corpos = [];
      for (const [rotulo, montar] of variantes) {
        const r = await montar();
        exigirStatus(r, NAO_AUTORIZADO[0], rotulo, NAO_AUTORIZADO[1]);
        assert.equal(cookieDoTabletNaResposta(r), null, rotulo);
        corpos.push(JSON.stringify(r.body));
      }
      assert.equal(new Set(corpos).size, 1, 'corpos idênticos');
      assert.equal((await a.linha(t.id)).ultimo_contato_em, null);
    });

    test('H06 — tablet revogado: 401 e nenhuma gravação de contato nem de restabelecimento', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const revogado = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${t.id}/revogar`);
      assert.equal(revogado.status, 200, JSON.stringify(revogado.body));
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, NAO_AUTORIZADO[0], 'tablet revogado', NAO_AUTORIZADO[1]);
      assert.equal((await a.linha(t.id)).ultimo_contato_em, null);
      assert.deepEqual(await a.tiposDeTransicao(t.id), []);
    });

    test('H07 — rede não autorizada: 403, o contato NÃO é gravado, o evento REDE_RECUSADA existe e a rotação devida não acontece', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const antes = await a.linha(t.id);
      await a.redes({ A: [], B: [] });
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, 403, 'rede recusada', 'REDE_NAO_AUTORIZADA');
      const depoisDaRecusa = await a.linha(t.id);
      assert.equal(depoisDaRecusa.ultimo_contato_em, null);
      assert.equal(depoisDaRecusa.credencial_hash, antes.credencial_hash, 'nunca rotaciona para origem não autorizada');
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.ok((await a.eventos(t.id, 'REDE_RECUSADA')).length >= 1);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 0);
    });

    test('H08 — corpo e query são estritos: campo extra, empresa/credencial no corpo ou parâmetro de query é 400 VALIDACAO, sem eco do valor e sem gravar contato', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const invalidos = [
        ['campo extra', () => a.heartbeat(app, t.credencial, { corpo: { x: 1 } })],
        ['empresaId no corpo', () => a.heartbeat(app, t.credencial, { corpo: { empresaId: B() } })],
        ['credencial no corpo', () => a.heartbeat(app, t.credencial, { corpo: { credencial: t.credencial } })],
        ['parâmetro de query', () => request(app).post(`${HEARTBEAT}?x=1`).set('Origin', ORIGEM).set('Cookie', cookieDoTablet(t.credencial)).send({})],
      ];
      for (const [rotulo, montar] of invalidos) {
        const r = await montar();
        exigirStatus(r, 400, rotulo, 'VALIDACAO');
        assert.equal(JSON.stringify(r.body).includes(t.credencial), false, `${rotulo}: não ecoa a credencial`);
      }
      assert.equal((await a.linha(t.id)).ultimo_contato_em, null);
    });
  });

  // ───────────────────────── isolamento entre empresas ─────────────────────────
  describe('isolamento por empresa', () => {
    test('H09 — a identidade vem SÓ da credencial: x-empresa-id/x-dispositivo-id são ignorados; o tablet de outra empresa não é tocado', async () => {
      await a.redesDasDuasEmpresas();
      const daA = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const daB = await a.ativado(B(), { horasDesdeEmissao: 1 });
      const r = await a.heartbeat(app, daA.credencial, { cabecalhos: { 'x-empresa-id': String(B()), 'x-dispositivo-id': String(daB.id) } });
      exigirStatus(r, 200, 'heartbeat do tablet A');
      assert.equal(await recente(daA.id), true);
      assert.equal((await a.linha(daB.id)).ultimo_contato_em, null, 'o tablet da outra empresa não pode ser tocado');
      assert.equal(await eventosDo(daB.id), 0);
    });

    test('H17 — o restabelecimento de um tablet não restabelece o de outra empresa que também está OFFLINE', async () => {
      await a.redesDasDuasEmpresas();
      const daA = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const daB = await a.ativado(B(), { horasDesdeEmissao: 1 });
      for (const t of [daA, daB]) {
        await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '1000 seconds', comunicacao_registrada = 'OFFLINE' WHERE id = $1", [t.id]);
        await a.q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo, ocorrido_em) VALUES ($1, $2, 'QUEDA', now() - interval '700 seconds')", [t.empresaId, t.id]);
      }
      exigirStatus(await a.heartbeat(app, daA.credencial), 200, 'heartbeat da empresa A');
      assert.deepEqual(await a.tiposDeTransicao(daA.id), ['QUEDA', 'RESTABELECIMENTO']);
      assert.deepEqual(await a.tiposDeTransicao(daB.id), ['QUEDA']);
      assert.equal((await a.linha(daB.id)).comunicacao_registrada, 'OFFLINE');
    });
  });

  // ───────────────────────── independência do atendimento do funcionário ─────────────────────────
  describe('independência do atendimento do funcionário', () => {
    test('H10 — o heartbeat não renova, não encerra nem reabre o atendimento, nem emite cookie de atendimento (vigente ou já vencido)', async () => {
      const t = await a.tabletNovo(A(), 1);
      const c = await a.cenario(app, { tablet: t });
      for (const restante of [20, -30]) {
        await forcarRestante(c.atendimentoId, restante);
        const antes = JSON.stringify(await a.atendimento(c.atendimentoId));
        const r = await a.pedir(app, 'POST', HEARTBEAT, c.t, c.token);
        exigirStatus(r, 200, `heartbeat com atendimento (restante ${restante} s)`);
        assert.equal(cookieDoAtendimentoNaResposta(r), null, 'o heartbeat não toca o cookie do atendimento');
        assert.equal(JSON.stringify(await a.atendimento(c.atendimentoId)), antes, 'a linha do atendimento não pode mudar');
      }
      await forcarRestante(c.atendimentoId, 20);
      exigirStatus(await a.pedir(app, 'POST', HEARTBEAT, c.t, c.token), 200, 'heartbeat com atendimento vigente');
      const consulta = await a.consultar(app, c.t, c.token);
      assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
      assert.ok(consulta.body.atendimento.restanteSegundos <= 20, 'o prazo não foi prorrogado pelo heartbeat');
    });

    test('H12 — o heartbeat não altera pedidos, estoque, entregas, fichas, atendimentos, sessões nem a auditoria', async () => {
      const t = await a.tabletNovo(A(), 1);
      await a.cenario(app, { tablet: t });
      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '1 hour' WHERE id = $1", [t.id]);
      const auditoriaAntes = await a.contagem('SELECT count(*)::int AS n FROM logs_auditoria');
      const antes = await a.fotografiaSegura();
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'heartbeat');
      assert.deepEqual(await a.fotografiaSegura(), antes);
      assert.equal(await a.contagem('SELECT count(*)::int AS n FROM logs_auditoria'), auditoriaAntes);
    });
  });

  // ───────────────────────── restabelecimento ─────────────────────────
  describe('RESTABELECIMENTO feito pelo heartbeat', () => {
    async function tabletOffline(duracaoDoSilencio = 1000, quedaHa = 700) {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      await a.q(`UPDATE token_dispositivos SET ultimo_contato_em = now() - make_interval(secs => ${duracaoDoSilencio}), comunicacao_registrada = 'OFFLINE' WHERE id = $1`, [t.id]);
      await a.q(`INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo, ocorrido_em) VALUES ($1, $2, 'QUEDA', now() - make_interval(secs => ${quedaHa}))`, [A(), t.id]);
      return t;
    }

    test('H13 — o primeiro heartbeat de um tablet OFFLINE registra ONLINE e UM RESTABELECIMENTO da empresa certa, com duração coerente', async () => {
      const t = await tabletOffline();
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'heartbeat de volta');
      assert.equal((await a.linha(t.id)).comunicacao_registrada, 'ONLINE');
      const restabelecimentos = await a.restabelecimentos(t.id);
      assert.equal(restabelecimentos.length, 1);
      assert.equal(restabelecimentos[0].empresa_id, A());
      assert.ok(Number.isInteger(restabelecimentos[0].duracao_segundos) && restabelecimentos[0].duracao_segundos >= 700, `duração ${restabelecimentos[0].duracao_segundos}`);
      assert.deepEqual(await a.tiposDeTransicao(t.id), ['QUEDA', 'RESTABELECIMENTO']);
    });

    test('H14 — oito primeiros heartbeats simultâneos de um tablet OFFLINE geram exatamente um RESTABELECIMENTO', async () => {
      const t = await tabletOffline();
      const respostas = await Promise.all(Array.from({ length: 8 }, () => a.heartbeat(app, t.credencial)));
      respostas.forEach((r, i) => exigirStatus(r, 200, `batida simultânea ${i + 1}`));
      assert.equal((await a.restabelecimentos(t.id)).length, 1);
    });

    test('H15 — batidas posteriores a um restabelecimento não o repetem', async () => {
      const t = await tabletOffline();
      exigirStatus(await a.heartbeat(app, t.credencial), 200, 'volta');
      for (let i = 0; i < 3; i += 1) {
        await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '2 minutes' WHERE id = $1", [t.id]);
        exigirStatus(await a.heartbeat(app, t.credencial), 200, `batida ${i + 2}`);
      }
      assert.equal((await a.restabelecimentos(t.id)).length, 1);
      assert.equal((await a.quedas(t.id)).length, 1);
    });
  });

  // ───────────────────────── sigilo ─────────────────────────
  describe('sigilo', () => {
    test('H18 — a resposta é mínima: só { status }, sem credencial, nome, unidade, setor, empresa nem identificador', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 1 });
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, 200, 'heartbeat');
      assert.deepEqual(Object.keys(r.body), ['status']);
      assert.deepEqual(varrer([{ corpo: r.body }], [t.credencial]), []);
      const linha = await a.linha(t.id);
      assert.equal(JSON.stringify(r.body).includes(linha.nome), false);
    });
  });
});
