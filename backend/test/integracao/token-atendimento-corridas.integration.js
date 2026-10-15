'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { ATENDIMENTO_INVALIDO, cookieDoAtendimentoNaResposta, abrirAmbienteAtendimento } = require('./helpers/token-atendimento');
const { cookieDoTabletNaResposta } = require('./helpers/token-tablet');
const { hashTokenSessao, gerarTokenSessao } = require('../../src/security/token');
const credencialRepo = require('../../src/repositories/token-credencial.repository');
const eventoRepo = require('../../src/repositories/token-dispositivo-evento.repository');

/**
 * Atendimento Token — Etapa D: corridas DETERMINÍSTICAS entre a reativação administrativa do tablet (recuperação da Etapa C) e as
 * operações do atendimento. PostgreSQL real, schema temporário. Mesma sincronização da Etapa C: uma transação concorrente SEGURA a trava
 * da linha do tablet; a requisição sob teste bloqueia nela (confirmado por `pg_blocking_pids`, sem tempo arbitrário); só então a
 * concorrente grava a recuperação com os escritores REAIS da Etapa C (credencial substituída e evento ATIVACAO) e confirma, e a
 * requisição é reavaliada sob a trava.
 *
 *   T1 identificação (credencial antiga) x recuperação   T2 atividade x recuperação   T3 encerramento x recuperação
 *   T4 fechamento por inatividade x recuperação          T5 atividade + nova identificação (credencial nova) após a recuperação
 *   T6 ativação REAL x identificação (rodadas, invariantes)
 */

const LIMITE_DE_SEGURANCA_MS = 10000;
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];

describe('Atendimento Token — D: corridas entre a reativação do tablet e o atendimento (PostgreSQL real)', () => {
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

  const tabletNovo = () => a.ativado(a.d.empresaA);
  async function comAtendimento() {
    const f = await a.funcionario(a.d.empresaA);
    const t = await tabletNovo();
    const r = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
    assert.equal(r.status, 201, `premissa: ${aviso(r)}`);
    const [linha] = await a.abertosDe(t.id);
    return { f, t, token: cookieDoAtendimentoNaResposta(r).valor, id: linha.id };
  }
  const forcarRestante = (id, segundos) => a.q(`UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() + make_interval(secs => $2::int) WHERE id = $1`, [id, segundos]);
  const esperando = async (pid) => (await a.q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].n;

  /** `disparar()` espera a trava do tablet segurada por uma transação que, então, grava `mudanca` e confirma. */
  async function corrida(tabletId, disparar, mudanca) {
    const concorrente = await a.ctx.pool.connect();
    let confirmou = false;
    try {
      await concorrente.query('BEGIN');
      await concorrente.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [tabletId]);
      const pid = (await concorrente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let encerrada = false;
      const resposta = disparar().then((r) => { encerrada = true; return r; });
      const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
      while (!encerrada && (await esperando(pid)) === 0) {
        if (Date.now() > prazo) assert.fail('a requisição não chegou a esperar a trava nem terminou (limite de segurança do teste)');
        await new Promise((resolver) => setImmediate(resolver));
      }
      assert.equal(encerrada, false, 'a operação deveria ESPERAR a trava do tablet');
      await mudanca(concorrente);
      await concorrente.query('COMMIT');
      confirmou = true;
      return await resposta;
    } finally {
      if (!confirmou) await concorrente.query('ROLLBACK').catch(() => {});
      concorrente.release();
    }
  }

  /** A recuperação da Etapa C, com os escritores reais: credencial substituída, sem anterior, e evento ATIVACAO. */
  function recuperar(t) {
    const nova = gerarTokenSessao();
    const mudanca = async (c) => {
      assert.equal(await credencialRepo.emitirNaAtivacao(c, { empresaId: t.empresaId, id: t.id, credencialHash: hashTokenSessao(nova) }), true, 'premissa: o escritor real da recuperação');
      await eventoRepo.registrar(c, { empresaId: t.empresaId, dispositivoId: t.id, tipo: 'ATIVACAO' });
    };
    return { nova, mudanca };
  }

  test('T1 — identificação autenticada com a credencial ANTIGA que chega ao banco DEPOIS da recuperação: 401 DISPOSITIVO_NAO_AUTORIZADO, nenhum atendimento criado e o aberto fica intacto', async () => {
    const x = await comAtendimento();
    const outro = await a.funcionario(a.d.empresaA);
    const antes = await a.atendimento(x.id);
    const { mudanca } = recuperar(x.t);
    const r = await corrida(x.t.id, () => a.identificar(app, x.t.credencial, { tipo: 'CPF', valor: outro.cpf }), mudanca);
    assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
    assert.equal(cookieDoAtendimentoNaResposta(r), null);
    assert.equal((await a.atendimentosDe(x.t.id)).length, 1);
    assert.deepEqual(await a.atendimento(x.id), antes);
  });

  test('T2 — atividade com a credencial ANTIGA que chega depois da recuperação: 401 e o prazo NÃO é renovado', async () => {
    const x = await comAtendimento();
    await forcarRestante(x.id, 20);
    const antes = await a.atendimento(x.id);
    const { mudanca } = recuperar(x.t);
    const r = await corrida(x.t.id, () => a.prorrogar(app, x.t, x.token), mudanca);
    assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
    assert.deepEqual(await a.atendimento(x.id), antes, 'expira_em intacto');
  });

  test('T3 — encerramento voluntário com a credencial ANTIGA que chega depois da recuperação: 401 e o registro não é fechado como SAIDA', async () => {
    const x = await comAtendimento();
    const antes = await a.atendimento(x.id);
    const { mudanca } = recuperar(x.t);
    const r = await corrida(x.t.id, () => a.encerrarAtendimento(app, x.t, x.token), mudanca);
    assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
    assert.deepEqual(await a.atendimento(x.id), antes);
  });

  test('T4 — o fechamento por inatividade (consulta ao atendimento vencido) disputado com a recuperação fecha UMA vez como INATIVIDADE, com uma só auditoria, e nunca como causa de reativação', async () => {
    const x = await comAtendimento();
    await forcarRestante(x.id, -10);
    const antes = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).length;
    const { nova, mudanca } = recuperar(x.t);
    const r = await corrida(x.t.id, () => a.consultar(app, x.t, x.token), mudanca);
    // A consulta foi autenticada com a credencial antiga ANTES da recuperação (a trava só entra no fechamento): a resposta é a única genérica.
    assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
    assert.equal((await a.atendimento(x.id)).motivo_encerramento, 'INATIVIDADE');
    const registros = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).slice(antes);
    assert.deepEqual(registros.map((l) => l.contexto), [{ motivo: 'INATIVIDADE', dispositivoId: x.t.id, funcionarioId: x.f.id }]);
    assert.equal((await a.consultar(app, { credencial: nova }, x.token)).status, 401);
  });

  test('T5 — depois da recuperação, atividade e nova identificação CONCORRENTES com a credencial nova (6 rodadas): o atendimento anterior nunca é renovado, a identificação termina com UM aberto válido e o anterior fecha como SUBSTITUIDO', async () => {
    for (let i = 0; i < 6; i += 1) {
      const x = await comAtendimento();
      await forcarRestante(x.id, 30);
      const codigo = (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${x.t.id}/ativacao`)).body.ativacao.codigo;
      const nova = cookieDoTabletNaResposta(await a.ativar(app, codigo)).valor;
      const outro = await a.funcionario(a.d.empresaA);
      const expiraAntes = (await a.atendimento(x.id)).expira_em;
      const [atividade, identificacao] = await Promise.all([
        a.prorrogar(app, { credencial: nova }, x.token),
        a.identificar(app, nova, { tipo: 'CPF', valor: outro.cpf }),
      ]);
      assert.deepEqual([atividade.status, atividade.body.codigo], ATENDIMENTO_INVALIDO, `rodada ${i}: ${aviso(atividade)}`);
      assert.equal(identificacao.status, 201, `rodada ${i}: ${aviso(identificacao)}`);
      const velho = await a.atendimento(x.id);
      assert.deepEqual(velho.expira_em, expiraAntes, `rodada ${i}: o anterior não foi renovado`);
      assert.equal(velho.motivo_encerramento, 'SUBSTITUIDO', `rodada ${i}`);
      const abertos = await a.abertosDe(x.t.id);
      assert.equal(abertos.length, 1, `rodada ${i}`);
      assert.equal(abertos[0].token_hash, hashTokenSessao(cookieDoAtendimentoNaResposta(identificacao).valor));
    }
  });

  test('T7 — a recuperação de UM tablet não toca no atendimento de outro tablet (mesma empresa): o atendimento do outro segue válido e renovável', async () => {
    const x = await comAtendimento(); const outro = await comAtendimento();
    const codigo = (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${x.t.id}/ativacao`)).body.ativacao.codigo;
    assert.equal((await a.ativar(app, codigo)).status, 200);
    assert.equal((await a.consultar(app, outro.t, outro.token)).status, 200);
    assert.equal((await a.prorrogar(app, outro.t, outro.token)).status, 200);
    assert.equal((await a.abertosDe(outro.t.id)).length, 1);
  });

  test('T6 — ativação administrativa REAL concorrente com identificação feita com a credencial antiga (8 rodadas): nenhum 5xx, a identificação é 201 ou 401 DISPOSITIVO_NAO_AUTORIZADO, no máximo UM aberto, e a credencial antiga nunca opera nenhum atendimento', async () => {
    for (let i = 0; i < 8; i += 1) {
      const f = await a.funcionario(a.d.empresaA);
      const t = await tabletNovo();
      const codigo = (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${t.id}/ativacao`)).body.ativacao.codigo;
      const [ativacao, identificacao] = await Promise.all([
        a.ativar(app, codigo),
        a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf }),
      ]);
      assert.equal(ativacao.status, 200, `rodada ${i}: ${aviso(ativacao)}`);
      assert.ok(identificacao.status === 201 || (identificacao.status === 401 && identificacao.body.codigo === 'DISPOSITIVO_NAO_AUTORIZADO'), `rodada ${i}: ${aviso(identificacao)}`);
      const abertos = await a.abertosDe(t.id);
      assert.ok(abertos.length <= 1, `rodada ${i}`);
      assert.equal(abertos.length, identificacao.status === 201 ? 1 : 0, `rodada ${i}: aberto só se a identificação foi aceita`);
      if (identificacao.status === 201) {
        const token = cookieDoAtendimentoNaResposta(identificacao).valor;
        for (const chamada of [() => a.consultar(app, t, token), () => a.prorrogar(app, t, token), () => a.encerrarAtendimento(app, t, token)]) {
          const r = await chamada();
          assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, `rodada ${i}: a credencial antiga não opera: ${aviso(r)}`);
        }
      }
    }
  });
});
