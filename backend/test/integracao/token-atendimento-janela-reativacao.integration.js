'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  ATENDIMENTO_INVALIDO, BASE, cabecalhoCookie, cookieDoAtendimentoNaResposta, abrirAmbienteAtendimento,
} = require('./helpers/token-atendimento');
const { ORIGEM, IP_TESTE } = require('./helpers/token-tablet');
const tokenTabletService = require('../../src/services/token-tablet.service');

/**
 * Atendimento Token — Etapa D: JANELA DE REATIVAÇÃO. PostgreSQL real, schema temporário. Sem tempo arbitrário.
 * ESTADO: nasceu RED (J1–J3 falhavam com o evento ATIVACAO como marcador) e está GREEN com a correção: o marcador de "tablet reativado" é
 * o consumo do código de ativação (token_ativacoes.usado_em, clock_timestamp() sob a trava do tablet). Os comentários abaixo descrevem a
 * causa que o teste continua provando (J0) e o comportamento exigido (J1–J3).
 *
 * Regra aprovada (D-D7): um atendimento aberto ANTES de a reativação administrativa do tablet ser efetivada nunca pode ser usado, nem com
 * a credencial nova. A Etapa D detecta isso comparando `iniciado_em` do atendimento com o instante da recuperação.
 *
 * CAUSA que este teste demonstra: o evento ATIVACAO que a Etapa C grava na recuperação usa o DEFAULT `now()` da coluna `ocorrido_em` — o
 * instante de INÍCIO da transação de recuperação —, enquanto o `iniciado_em` do atendimento é `clock_timestamp()` lido DENTRO da trava
 * do tablet. Se a transação de recuperação já tinha começado (BEGIN) mas ainda esperava a trava, uma identificação que conclui nesse
 * intervalo ganha `iniciado_em` POSTERIOR ao evento, embora tenha sido criada ANTES de a recuperação valer. A ordem real dos eventos (a
 * trava do tablet) e a ordem dos timestamps ficam INVERTIDAS, e o atendimento anterior passa a ser aceito com a credencial nova.
 *
 * COMO é reproduzido sem tempo: o serviço REAL `tokenTabletService.ativar` roda com um pool instrumentado que PAUSA, até o teste liberar,
 * exatamente no ponto em que a transação de recuperação (já iniciada) pede a trava do tablet — o instante em que, em produção, um
 * escalonamento qualquer a atrasaria. Durante a pausa o teste faz uma identificação REAL com a credencial antiga (a trava está livre).
 * Depois libera a recuperação. Não há sleep, probabilidade nem corrida: a ordem é imposta pelo teste.
 *
 *   J1/J2/J3  estado, atividade e encerramento com a credencial NOVA sobre o atendimento aberto na janela: devem ser 401 (com o evento ATIVACAO como marcador eram 200).
 *   K1        controle: a mesma sequência sem a janela (recuperação inteira antes da identificação) -> o atendimento novo é válido.
 *   K2        controle: identificação ANTES da recuperação, sem inversão de timestamps -> o anterior é recusado.
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

describe('Atendimento Token — D: janela de reativação do tablet (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbienteAtendimento();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const gerarCodigo = async (tabletId) => (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${tabletId}/ativacao`)).body.ativacao.codigo;

  /** Pool que, na PRIMEIRA consulta que pede a trava da linha do tablet (FOR UPDATE OF d), avisa `pausado` e espera `liberar()`. */
  function poolPausavel(poolReal) {
    let liberar;
    let pausou;
    const liberada = new Promise((resolver) => { liberar = resolver; });
    const pausado = new Promise((resolver) => { pausou = resolver; });
    let jaPausou = false;
    const envolver = (client) => ({
      release: (...args) => client.release(...args),
      async query(texto, ...resto) {
        if (!jaPausou && typeof texto === 'string' && texto.includes('FOR UPDATE OF d')) {
          jaPausou = true;
          pausou();
          await liberada;
        }
        return client.query(texto, ...resto);
      },
    });
    return {
      pool: { query: (...args) => poolReal.query(...args), connect: async () => envolver(await poolReal.connect()) },
      pausado,
      liberar,
    };
  }

  /**
   * Imposição da janela: a recuperação (real) INICIA a transação, a identificação com a credencial antiga CONCLUI, e só então a
   * recuperação obtém a trava e confirma. Devolve o atendimento aberto na janela, a credencial nova e os instantes observados.
   */
  async function abrirNaJanela() {
    const f = await a.funcionario(a.d.empresaA);
    const t = await a.ativado(a.d.empresaA);
    const codigo = await gerarCodigo(t.id);
    const pausa = poolPausavel(a.ctx.pool);
    const ativacao = tokenTabletService.ativar(pausa.pool, { codigo, ip: IP_TESTE, agente: null });
    await pausa.pausado; // a transação de recuperação já começou (BEGIN) e está pedindo a trava do tablet
    const identificacao = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
    assert.equal(identificacao.status, 201, `premissa: a identificação conclui durante a janela → ${aviso(identificacao)}`);
    const token = cookieDoAtendimentoNaResposta(identificacao).valor;
    pausa.liberar();
    const { credencial: nova } = await ativacao;
    const [linha] = await a.abertosDe(t.id);
    const [evento] = await a.eventos(t.id, 'ATIVACAO');
    const { rows: [uso] } = await a.q('SELECT usado_em FROM token_ativacoes WHERE dispositivo_id = $1 AND usado_em IS NOT NULL ORDER BY id DESC LIMIT 1', [t.id]);
    return { f, t, token, nova, linha, evento, uso };
  }

  test('J0 — PREMISSA que prova a inversão: o evento ATIVACAO da recuperação tem ocorrido_em ANTERIOR ao iniciado_em do atendimento criado ANTES de a recuperação valer, enquanto o uso do código (clock_timestamp sob a trava) é POSTERIOR: a ordem real é identificação -> recuperação, mas os timestamps do evento dizem o contrário', async () => {
    const x = await abrirNaJanela();
    assert.ok(x.evento.ocorrido_em < x.linha.iniciado_em, `evento ${x.evento.ocorrido_em.toISOString()} deveria ser anterior ao início ${x.linha.iniciado_em.toISOString()} (inversão por now() de início de transação)`);
    assert.ok(x.uso.usado_em > x.linha.iniciado_em, 'o consumo do código acontece sob a trava, depois da identificação: reflete a ordem real');
    const antiga = await a.consultar(app, x.t, x.token);
    assert.deepEqual([antiga.status, antiga.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], 'a credencial antiga já é recusada (isso nunca foi o problema)');
  });

  test('J1 — ESTADO com a credencial NOVA sobre o atendimento aberto antes da reativação: 401 ATENDIMENTO_INVALIDO', async () => {
    const x = await abrirNaJanela();
    const r = await a.consultar(app, { credencial: x.nova }, x.token);
    assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `o atendimento anterior à reativação foi aceito: ${aviso(r)}`);
  });

  test('J2 — ATIVIDADE com a credencial NOVA sobre o atendimento aberto antes da reativação: 401 e o prazo NÃO é renovado', async () => {
    const x = await abrirNaJanela();
    const antes = await a.atendimento(x.linha.id);
    const r = await a.prorrogar(app, { credencial: x.nova }, x.token);
    assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `o atendimento anterior à reativação foi mantido: ${aviso(r)}`);
    assert.deepEqual(await a.atendimento(x.linha.id), antes, 'expira_em intacto');
  });

  test('J3 — ENCERRAMENTO voluntário com a credencial NOVA sobre o atendimento aberto antes da reativação: 401 e o registro não é fechado como SAIDA', async () => {
    const x = await abrirNaJanela();
    const antes = await a.atendimento(x.linha.id);
    const r = await a.encerrarAtendimento(app, { credencial: x.nova }, x.token);
    assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `o atendimento anterior à reativação foi operado: ${aviso(r)}`);
    assert.deepEqual(await a.atendimento(x.linha.id), antes);
  });

  test('K1 — controle (sem a janela): SEM a janela (a recuperação inteira antes da identificação) o atendimento aberto com a credencial NOVA é válido e renovável', async () => {
    const f = await a.funcionario(a.d.empresaA);
    const t = await a.ativado(a.d.empresaA);
    const { credencial: nova } = await tokenTabletService.ativar(a.ctx.pool, { codigo: await gerarCodigo(t.id), ip: IP_TESTE, agente: null });
    const r = await a.identificar(app, nova, { tipo: 'CPF', valor: f.cpf });
    assert.equal(r.status, 201, aviso(r));
    const token = cookieDoAtendimentoNaResposta(r).valor;
    assert.equal((await a.consultar(app, { credencial: nova }, token)).status, 200);
    assert.equal((await a.prorrogar(app, { credencial: nova }, token)).status, 200);
  });

  test('K2 — controle (sem a janela): identificação ANTES da recuperação, em ordem normal (sem a recuperação ter começado), é recusada com a credencial nova', async () => {
    const f = await a.funcionario(a.d.empresaA);
    const t = await a.ativado(a.d.empresaA);
    const r = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
    assert.equal(r.status, 201, aviso(r));
    const token = cookieDoAtendimentoNaResposta(r).valor;
    const { credencial: nova } = await tokenTabletService.ativar(a.ctx.pool, { codigo: await gerarCodigo(t.id), ip: IP_TESTE, agente: null });
    const depois = await a.consultar(app, { credencial: nova }, token);
    assert.deepEqual([depois.status, depois.body.codigo], ATENDIMENTO_INVALIDO, aviso(depois));
  });

  test('K4 — gerar o QR SEM consumi-lo (nem cancelá-lo) não encerra nem invalida o atendimento aberto; gerar de novo (cancela o anterior) também não; os 60 s seguem: a atividade reinicia o prazo e o vencimento fecha como INATIVIDADE', async () => {
    const f = await a.funcionario(a.d.empresaA);
    const t = await a.ativado(a.d.empresaA);
    const r = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
    assert.equal(r.status, 201, aviso(r));
    const token = cookieDoAtendimentoNaResposta(r).valor;
    const [linha] = await a.abertosDe(t.id);
    await gerarCodigo(t.id);
    await gerarCodigo(t.id); // o segundo cancela o primeiro (usado_em segue nulo nos dois)
    const { rows: [soma] } = await a.q('SELECT count(*)::int AS total, count(usado_em)::int AS usados, count(cancelado_em)::int AS cancelados FROM token_ativacoes WHERE dispositivo_id = $1', [t.id]);
    assert.ok(soma.usados <= 1 && soma.cancelados >= 1, `premissa: houve geração e cancelamento sem consumo novo (${JSON.stringify(soma)})`);
    assert.equal((await a.consultar(app, t, token)).status, 200, 'o atendimento segue válido com a credencial atual');
    const renovado = await a.prorrogar(app, t, token);
    assert.equal(renovado.status, 200, aviso(renovado));
    assert.ok(renovado.body.atendimento.restanteSegundos > 55 && renovado.body.atendimento.restanteSegundos <= 60);
    assert.equal((await a.atendimento(linha.id)).encerrado_em, null);
    await a.q("UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() - interval '5 seconds' WHERE id = $1", [linha.id]);
    const vencido = await a.consultar(app, t, token);
    assert.deepEqual([vencido.status, vencido.body.codigo], ATENDIMENTO_INVALIDO, aviso(vencido));
    assert.equal((await a.atendimento(linha.id)).motivo_encerramento, 'INATIVIDADE');
  });

  test('K3 — controle (sem a janela): a janela NÃO deixa um atendimento criado com a credencial ANTIGA depois que a recuperação passou a valer (a reconferência da credencial sob a trava o recusa)', async () => {
    const f = await a.funcionario(a.d.empresaA);
    const t = await a.ativado(a.d.empresaA);
    await tokenTabletService.ativar(a.ctx.pool, { codigo: await gerarCodigo(t.id), ip: IP_TESTE, agente: null });
    const r = await request(app).post(BASE).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(t.credencial, null)).send({ tipo: 'CPF', valor: f.cpf });
    assert.deepEqual([r.status, r.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(r));
    assert.equal((await a.atendimentosDe(t.id)).length, 0);
  });
});
