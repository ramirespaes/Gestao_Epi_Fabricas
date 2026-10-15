'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { REDE_DE_TESTE, exigirStatus, abrirAmbienteJ } = require('./helpers/token-j');
const { cookieDoTabletNaResposta, CAMINHO_TABLET } = require('./helpers/token-tablet');
const { gerarTokenSessao, hashTokenSessao, tokenSessaoTemFormatoValido } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Atendimento Token — Etapa J, J2a (RED), D17: heartbeat × rotação da credencial do tablet. PostgreSQL real, schema temporário.
 *
 * A autenticação e a política de rotação da Etapa C ficam EXATAMENTE como estão (24 h de rotação, carência da anterior, REUSO_CREDENCIAL
 * fora dela, rede decidida antes da rotação). O heartbeat é só mais um portador da rotação. Os controles K provam, com a rota existente
 * (/estado), o comportamento de referência; os testes D exigem o mesmo comportamento pelo heartbeat.
 *
 * Razão contratual esperada dos testes D: resposta 404 ROTA_NAO_ENCONTRADA no caminho do heartbeat. Os controles K passam já no RED.
 *
 * Limite assumido do teste (RISCO-J-01, não fechado por mock): o servidor só garante que UMA resposta carrega o Set-Cookie novo. A ordem
 * de chegada das respostas no navegador, a perda real do Set-Cookie e uma resposta atrasada que chegue depois de uma reativação só se
 * validam em rede real, com tablet físico (homologação). Aqui a "perda" é simulada descartando o Set-Cookie no teste.
 */

const ESTADO = `${CAMINHO_TABLET}/estado`;
const CARENCIA_S = () => authConfig.dispositivo.carenciaSegundos;
const COOKIES_DO_TABLET = (respostas) => respostas.map(cookieDoTabletNaResposta).filter((c) => c !== null);

describe('Atendimento Token — J2a/D17: rotação da credencial do tablet pelo heartbeat (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;
  const A = () => a.d.empresaA;

  before(async () => {
    a = await abrirAmbienteJ();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes({ A: [...REDE_DE_TESTE], B: [] }); });

  const estado = (credencial) => a.comoTablet(app, credencial).get(ESTADO);
  const envelhecerEmissao = (id, intervalo) => a.q(`UPDATE token_dispositivos SET credencial_emitida_em = now() - interval '${intervalo}' WHERE id = $1`, [id]);
  const renovadas = async (id) => (await a.eventos(id, 'CREDENCIAL_RENOVADA')).length;
  const reusos = async (id) => (await a.eventos(id, 'REUSO_CREDENCIAL')).length;

  /** Rotação pelo heartbeat: devolve a credencial nova e confere a troca no banco. */
  async function rotacionarPorHeartbeat(t) {
    const r = await a.heartbeat(app, t.credencial);
    exigirStatus(r, 200, 'heartbeat com rotação devida');
    const cookie = cookieDoTabletNaResposta(r);
    assert.ok(cookie, 'a rotação devida emite o novo cookie do tablet');
    assert.equal(tokenSessaoTemFormatoValido(cookie.valor), true);
    assert.notEqual(cookie.valor, t.credencial);
    return { resposta: r, cookie, novo: cookie.valor };
  }

  // ───────────── controles: a referência é a rota existente (passam já no RED) ─────────────
  describe('controles com a rota existente (devem passar já no RED)', () => {
    test('K1 — rotação devida na rota /estado: novo Set-Cookie, anterior guardada, um CREDENCIAL_RENOVADA', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const r = await estado(t.credencial);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const cookie = cookieDoTabletNaResposta(r);
      assert.ok(cookie);
      const linha = await a.linha(t.id);
      assert.equal(linha.credencial_hash, hashTokenSessao(cookie.valor));
      assert.equal(linha.credencial_anterior_hash, hashTokenSessao(t.credencial));
      assert.equal(await renovadas(t.id), 1);
    });

    test('K2 — a anterior vale na carência sem rotacionar de novo e sem novo cookie', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const primeira = await estado(t.credencial);
      const hashNovo = (await a.linha(t.id)).credencial_hash;
      const r = await estado(t.credencial);
      assert.equal(primeira.status, 200);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.equal((await a.linha(t.id)).credencial_hash, hashNovo);
      assert.equal(await renovadas(t.id), 1);
    });

    test('K3 — fora da carência a anterior é recusada com a mesma 401 e gera REUSO_CREDENCIAL; a nova segue valendo', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const rotacao = await estado(t.credencial);
      const novo = cookieDoTabletNaResposta(rotacao).valor;
      await envelhecerEmissao(t.id, `${CARENCIA_S() + 600} seconds`);
      const recusada = await estado(t.credencial);
      assert.deepEqual([recusada.status, recusada.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO']);
      assert.equal(await reusos(t.id), 1);
      assert.equal((await estado(novo)).status, 200);
    });

    test('K4 — a reativação substitui a credencial e descarta a anterior: a rotacionada antes dela deixa de valer', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const rotacionada = cookieDoTabletNaResposta(await estado(t.credencial)).valor;
      const ativacao = await a.ativar(app, await a.codigoPendente(t));
      assert.equal(ativacao.status, 200, JSON.stringify(ativacao.body));
      assert.equal((await a.linha(t.id)).credencial_anterior_hash, null);
      assert.equal((await estado(rotacionada)).status, 401);
      assert.equal((await estado(cookieDoTabletNaResposta(ativacao).valor)).status, 200);
    });
  });

  // ───────────────────────── rotação pelo heartbeat ─────────────────────────
  describe('o heartbeat como portador da rotação', () => {
    test('D01 — rotação devida: o heartbeat devolve o novo Set-Cookie, guarda a anterior, registra UM CREDENCIAL_RENOVADA e conta como contato', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const { novo } = await rotacionarPorHeartbeat(t);
      const linha = await a.linha(t.id);
      assert.equal(linha.credencial_hash, hashTokenSessao(novo));
      assert.equal(linha.credencial_anterior_hash, hashTokenSessao(t.credencial));
      assert.equal(await renovadas(t.id), 1);
      assert.ok(linha.ultimo_contato_em instanceof Date);
    });

    test('D02 — resposta com Set-Cookie PERDIDA: o tablet segue com a anterior, que dentro da carência é aceita, conta como contato e NÃO rotaciona de novo', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const { novo } = await rotacionarPorHeartbeat(t);
      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '100 seconds' WHERE id = $1", [t.id]);
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, 200, 'batida com a credencial anterior dentro da carência');
      assert.equal(cookieDoTabletNaResposta(r), null, 'a anterior nunca recebe nova credencial');
      assert.equal((await a.linha(t.id)).credencial_hash, hashTokenSessao(novo), 'a atual não mudou');
      assert.equal(await renovadas(t.id), 1);
      assert.equal((await a.q("SELECT abs(extract(epoch FROM now() - ultimo_contato_em)) < 10 AS ok FROM token_dispositivos WHERE id = $1", [t.id])).rows[0].ok, true, 'contou como contato');
    });

    test('D03 — carência vencida: a anterior recebe a MESMA 401 de credencial desconhecida, gera REUSO_CREDENCIAL, não grava contato; a nova segue valendo', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const { novo } = await rotacionarPorHeartbeat(t);
      await envelhecerEmissao(t.id, `${CARENCIA_S() + 600} seconds`);
      await a.q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '5 minutes' WHERE id = $1", [t.id]);
      const contatoAntes = (await a.contatoDe(t.id)).ultimo_contato_em.getTime();
      const recusada = await a.heartbeat(app, t.credencial);
      const desconhecida = await a.heartbeat(app, gerarTokenSessao());
      exigirStatus(recusada, 401, 'anterior fora da carência', 'DISPOSITIVO_NAO_AUTORIZADO');
      assert.equal(JSON.stringify(recusada.body), JSON.stringify(desconhecida.body), 'não revela qual credencial era a atual');
      assert.equal(cookieDoTabletNaResposta(recusada), null);
      assert.equal(await reusos(t.id), 1);
      assert.equal((await a.contatoDe(t.id)).ultimo_contato_em.getTime(), contatoAntes, 'a recusa não grava contato');
      exigirStatus(await a.heartbeat(app, novo), 200, 'a credencial nova segue válida');
    });

    test('D04 — cinco heartbeats simultâneos na rotação devida: todos 200, exatamente UM Set-Cookie, UM CREDENCIAL_RENOVADA e a atual é a que saiu na resposta', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const respostas = await Promise.all(Array.from({ length: 5 }, () => a.heartbeat(app, t.credencial)));
      respostas.forEach((r, i) => exigirStatus(r, 200, `batida simultânea ${i + 1}`));
      const cookies = COOKIES_DO_TABLET(respostas);
      assert.equal(cookies.length, 1, 'um único emissor do cookie novo');
      assert.equal(await renovadas(t.id), 1);
      assert.equal((await a.linha(t.id)).credencial_hash, hashTokenSessao(cookies[0].valor));
    });

    test('D05 — heartbeat simultâneo com consulta e prorrogação do atendimento na rotação devida: nenhuma perde a autorização, um só Set-Cookie, um só evento', async () => {
      const t = await a.tabletNovo(A(), 1);
      const c = await a.cenario(app, { tablet: t });
      await envelhecerEmissao(t.id, '25 hours');
      const respostas = await Promise.all([
        a.heartbeat(app, t.credencial),
        a.consultar(app, t, c.token),
        a.prorrogar(app, t, c.token),
      ]);
      respostas.forEach((r, i) => exigirStatus(r, 200, `requisição simultânea ${i + 1}`));
      assert.equal(COOKIES_DO_TABLET(respostas).length, 1);
      assert.equal(await renovadas(t.id), 1);
    });

    test('D06 — heartbeat simultâneo com a identificação de um funcionário na rotação devida: 200 e 201, um só Set-Cookie, um só evento', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const f = await a.funcionario(A());
      const [batida, identificacao] = await Promise.all([
        a.heartbeat(app, t.credencial),
        a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf }),
      ]);
      exigirStatus(batida, 200, 'heartbeat');
      exigirStatus(identificacao, 201, 'identificação');
      assert.equal(COOKIES_DO_TABLET([batida, identificacao]).length, 1);
      assert.equal(await renovadas(t.id), 1);
      assert.equal((await a.abertosDe(t.id)).length, 1);
    });

    test('D07 — heartbeat simultâneo com o envio do pedido na rotação devida: o pedido é aceito (201), um só Set-Cookie, um só evento', async () => {
      const ghe = await a.ghe(A());
      const material = await a.material(A(), { nome: 'J Protetor', exigeTamanho: false });
      await a.vincularMaterial(A(), ghe, material);
      const t = await a.tabletNovo(A(), 1);
      const c = await a.cenario(app, { gheId: ghe, tablet: t });
      await envelhecerEmissao(t.id, '25 hours');
      const [batida, pedido] = await Promise.all([
        a.heartbeat(app, t.credencial),
        a.finalizar(app, c.t, c.token, a.corpo([a.item(material)])),
      ]);
      exigirStatus(batida, 200, 'heartbeat');
      exigirStatus(pedido, 201, 'pedido');
      assert.equal(COOKIES_DO_TABLET([batida, pedido]).length, 1);
      assert.equal(await renovadas(t.id), 1);
      assert.equal((await a.solicitacoesDe(c.f.id)).length, 1);
    });

    test('D08 — o cookie emitido pelo heartbeat tem os MESMOS atributos do emitido pela rotação da Etapa C (Path, HttpOnly, SameSite, Secure, validade)', async () => {
      const referencia = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const cookieC = cookieDoTabletNaResposta(await estado(referencia.credencial));
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const { cookie } = await rotacionarPorHeartbeat(t);
      assert.deepEqual(Object.keys(cookie.atributos).sort(), Object.keys(cookieC.atributos).sort());
      for (const nome of ['path', 'httponly', 'samesite', 'secure']) {
        assert.equal(cookie.atributos[nome], cookieC.atributos[nome], nome);
      }
      if (cookieC.atributos['max-age'] !== undefined) {
        assert.ok(Math.abs(Number(cookie.atributos['max-age']) - Number(cookieC.atributos['max-age'])) <= 5);
      }
    });
  });

  // ───────────────────────── reativação, revogação, expiração, política ─────────────────────────
  describe('reativação, revogação, expiração e política preservada', () => {
    test('D09 — resposta ATRASADA depois da reativação: nem a credencial rotacionada nem a original valem; só a emitida pela reativação, que volta a bater', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const { novo: atrasada } = await rotacionarPorHeartbeat(t);
      const reativacao = await a.ativar(app, await a.codigoPendente(t));
      assert.equal(reativacao.status, 200, JSON.stringify(reativacao.body));
      const aposReativar = cookieDoTabletNaResposta(reativacao).valor;
      assert.equal((await a.linha(t.id)).credencial_anterior_hash, null, 'a reativação não deixa credencial paralela');
      exigirStatus(await a.heartbeat(app, atrasada), 401, 'rotacionada (resposta atrasada)', 'DISPOSITIVO_NAO_AUTORIZADO');
      exigirStatus(await a.heartbeat(app, t.credencial), 401, 'original', 'DISPOSITIVO_NAO_AUTORIZADO');
      exigirStatus(await a.heartbeat(app, aposReativar), 200, 'credencial da reativação');
    });

    test('D10 — tablet revogado depois da rotação: a credencial atual e a anterior são recusadas e nada é gravado', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 25 });
      const { novo } = await rotacionarPorHeartbeat(t);
      const revogado = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${t.id}/revogar`);
      assert.equal(revogado.status, 200, JSON.stringify(revogado.body));
      const contatoAntes = (await a.contatoDe(t.id)).ultimo_contato_em.getTime();
      exigirStatus(await a.heartbeat(app, novo), 401, 'atual', 'DISPOSITIVO_NAO_AUTORIZADO');
      exigirStatus(await a.heartbeat(app, t.credencial), 401, 'anterior', 'DISPOSITIVO_NAO_AUTORIZADO');
      assert.equal((await a.contatoDe(t.id)).ultimo_contato_em.getTime(), contatoAntes);
    });

    test('D11 — credencial expirada (além da validade absoluta do cookie): 401, sem rotação e sem gravar contato', async () => {
      const horas = (authConfig.dispositivo.cookieDias + 1) * 24;
      const t = await a.ativado(A(), { horasDesdeEmissao: horas });
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, 401, 'credencial expirada', 'DISPOSITIVO_NAO_AUTORIZADO');
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.equal((await a.linha(t.id)).ultimo_contato_em, null);
      assert.equal(await renovadas(t.id), 0);
    });

    test('D14 — política preservada: com a credencial emitida há menos de 24 h o heartbeat NÃO rotaciona (sem Set-Cookie, sem evento)', async () => {
      const t = await a.ativado(A(), { horasDesdeEmissao: 23 });
      const antes = (await a.linha(t.id)).credencial_hash;
      const r = await a.heartbeat(app, t.credencial);
      exigirStatus(r, 200, 'heartbeat antes da rotação devida');
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.equal((await a.linha(t.id)).credencial_hash, antes);
      assert.equal(await renovadas(t.id), 0);
    });
  });
});
