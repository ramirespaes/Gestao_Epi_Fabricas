'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  abrirAmbiente, cookieDoTabletNaResposta, CAMINHO_TABLET, varrer,
} = require('./helpers/token-tablet');
const { hashTokenSessao, gerarTokenSessao } = require('../../src/security/token');
const credencialRepo = require('../../src/repositories/token-credencial.repository');
const ativacaoRepo = require('../../src/repositories/token-ativacao.repository');
const dispositivoRepo = require('../../src/repositories/token-dispositivo.repository');
const { authConfig } = require('../../src/config/auth');

/**
 * Atendimento Token — Etapa C: corridas DETERMINÍSTICAS (S1 a S5). PostgreSQL real em schema temporário.
 *
 * Sincronização sem tempo arbitrário: uma transação "concorrente" trava a linha do tablet e SEGURA a trava; a requisição sob teste
 * lê o estado (sem trava), tenta travar/atualizar e BLOQUEIA. O teste só prossegue quando o PostgreSQL informa que o backend da
 * requisição está esperando a trava do concorrente (`pg_blocking_pids`); se a requisição terminar antes, é falha funcional
 * ("não esperou a trava"). Só então o concorrente grava a sua mudança — com os escritores REAIS do código de produção — e confirma, e o
 * statement bloqueado é reavaliado sob a trava. O único relógio é o limite de segurança de 10 s contra travamento do teste.
 *
 *   S1 rotação x rotação      S2 rotação x recuperação      S3 rotação x revogação
 *   S4 consumo do código x revogação      S5 consumo do código x nova geração do código
 */

const ESTADO = `${CAMINHO_TABLET}/estado`;
const LIMITE_DE_SEGURANCA_MS = 10000;
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];
const CODIGO_INVALIDO = [401, 'ATIVACAO_INVALIDA'];

describe('Atendimento Token — C: corridas determinísticas S1 a S5 (PostgreSQL real)', () => {
  let a;
  let app;
  let gestorRevoga;

  before(async () => {
    a = await abrirAmbiente();
    app = a.criarApp({ hops: 0 });
    gestorRevoga = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const estado = (credencial) => a.comoTablet(app, credencial).get(ESTADO);
  const esperando = async (pidDoConcorrente) => (await a.q('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pidDoConcorrente])).rows[0].n;

  /**
   * Executa `disparar()` (a requisição sob teste) enquanto uma transação concorrente SEGURA a trava da linha do tablet; quando a
   * requisição estiver esperando essa trava, aplica `mudanca(clienteConcorrente)` e confirma. Devolve a resposta da requisição.
   */
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
      assert.equal(encerrada, false, 'a operação deveria ESPERAR a trava do tablet, e não prosseguir com uma leitura já velha');
      await mudanca(concorrente);
      await concorrente.query('COMMIT');
      confirmou = true;
      return await resposta;
    } finally {
      if (!confirmou) await concorrente.query('ROLLBACK').catch(() => {});
      concorrente.release();
    }
  }

  const criterios = () => ({ rotacaoHoras: authConfig.dispositivo.rotacaoHoras });

  test('S0 — invariante que sustenta a equivalência do mutante #20: com os limites de configuração, a carência da credencial anterior é SEMPRE menor que a rotação (a anterior nunca tem "rotação devida"); alargar os limites quebra este teste', () => {
    const { carregarConfigAuth } = require('../../src/config/auth');
    const base = { LOGIN_COOLDOWN_HMAC_SECRET: process.env.LOGIN_COOLDOWN_HMAC_SECRET };
    const extremo = carregarConfigAuth({ ...base, DISPOSITIVO_CARENCIA_SEGUNDOS: '600', DISPOSITIVO_ROTACAO_HORAS: '1' }).dispositivo;
    assert.ok(extremo.carenciaSegundos < extremo.rotacaoHoras * 3600, 'maior carência possível x menor rotação possível');
    assert.throws(() => carregarConfigAuth({ ...base, DISPOSITIVO_CARENCIA_SEGUNDOS: '601' }), /DISPOSITIVO_CARENCIA_SEGUNDOS/, 'acima do limite é recusado');
    assert.throws(() => carregarConfigAuth({ ...base, DISPOSITIVO_ROTACAO_HORAS: '0' }), /DISPOSITIVO_ROTACAO_HORAS/, 'abaixo do limite é recusado');
    assert.ok(authConfig.dispositivo.carenciaSegundos < authConfig.dispositivo.rotacaoHoras * 3600, 'também vale para a configuração em uso');
  });

  test('S1 — rotação x rotação: a perdedora não rotaciona de novo, autentica como "anterior" na carência, sem Set-Cookie e sem evento; a rotação da vencedora fica intacta e a credencial dela vale', async () => {
    const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
    const vencedora = gerarTokenSessao();
    const r = await corrida(t.id, () => estado(t.credencial), async (c) => {
      const rotacionou = await credencialRepo.rotacionar(c, { id: t.id, credencialAtualHash: hashTokenSessao(t.credencial), novaCredencialHash: hashTokenSessao(vencedora), ...criterios() });
      assert.equal(rotacionou, true, 'premissa: o escritor real rotaciona a credencial vencida');
    });
    assert.equal(r.status, 200, aviso(r));
    assert.equal(cookieDoTabletNaResposta(r), null, 'a perdedora não recebe credencial');
    const l = await a.linha(t.id);
    assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash, l.revogado_em], [hashTokenSessao(vencedora), hashTokenSessao(t.credencial), null], 'a rotação da vencedora ficou como estava');
    assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 0, 'a perdedora não gravou evento de rotação');
    assert.equal((await estado(vencedora)).status, 200, 'a credencial da vencedora vale');
  });

  test('S2 — rotação x recuperação: a credencial antiga é 401 e a rotação NÃO sobrescreve a recuperação; a credencial recuperada segue como a única, sem "anterior" e sem evento de rotação', async () => {
    const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
    const recuperada = gerarTokenSessao();
    const r = await corrida(t.id, () => estado(t.credencial), async (c) => {
      assert.equal(await credencialRepo.emitirNaAtivacao(c, { empresaId: a.d.empresaA, id: t.id, credencialHash: hashTokenSessao(recuperada) }), true, 'premissa: o escritor real da recuperação');
    });
    assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
    assert.equal(cookieDoTabletNaResposta(r), null, 'nenhuma credencial é entregue a quem só tinha a antiga');
    const l = await a.linha(t.id);
    assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash, l.revogado_em], [hashTokenSessao(recuperada), null, null], 'a credencial recuperada continua sendo a única');
    assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 0);
    assert.equal((await estado(recuperada)).status, 200);
    assert.deepEqual([(await estado(t.credencial)).status], [401], 'a antiga segue inválida depois da corrida');
  });

  test('S3 — rotação x revogação: 401, o tablet segue revogado e sem nenhuma credencial; nada reativa o dispositivo (nova geração é 409 e a credencial antiga continua 401)', async () => {
    const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
    const r = await corrida(t.id, () => estado(t.credencial), async (c) => {
      assert.ok(await dispositivoRepo.revogar(c, a.d.empresaA, t.id, gestorRevoga), 'premissa: o escritor real da revogação (Etapa B)');
    });
    assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
    assert.equal(cookieDoTabletNaResposta(r), null);
    const l = await a.linha(t.id);
    assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash], [null, null]);
    assert.ok(l.revogado_em instanceof Date && l.revogado_por === gestorRevoga);
    assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 0);
    assert.equal((await estado(t.credencial)).status, 401);
    const gerar = await a.comoAdmin(app, gestorRevoga).post(`/api/atendimento-token/dispositivos/${t.id}/ativacao`);
    assert.deepEqual([gerar.status, gerar.body.codigo], [409, 'DISPOSITIVO_REVOGADO'], 'um tablet revogado não volta a ser ativado');
  });

  test('S4 — consumo do código x revogação: 401 genérica, nenhuma credencial emitida, código cancelado (nunca "usado"), sem evento nem auditoria de ativação, e o tablet segue revogado', async () => {
    const x = await a.dispositivo(a.d.empresaA);
    const codigo = await a.codigoPendente(x);
    const r = await corrida(x.id, () => a.ativar(app, codigo), async (c) => {
      assert.ok(await dispositivoRepo.revogar(c, a.d.empresaA, x.id, gestorRevoga), 'premissa: revogação real (Etapa B)');
      assert.equal(await dispositivoRepo.cancelarAtivacoesPendentes(c, a.d.empresaA, x.id), 1, 'premissa: a revogação cancela a ativação pendente');
    });
    assert.deepEqual([r.status, r.body.codigo], CODIGO_INVALIDO, aviso(r));
    assert.equal(cookieDoTabletNaResposta(r), null);
    const l = await a.linha(x.id);
    assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash, l.ativado_em], [null, null, null]);
    assert.ok(l.revogado_em instanceof Date);
    const [ativacao] = await a.ativacoesDe(x.id);
    assert.ok(ativacao.cancelado_em instanceof Date && ativacao.usado_em === null, 'o código ficou cancelado, não consumido');
    assert.equal((await a.eventos(x.id, 'ATIVACAO')).length, 0);
    assert.equal((await a.auditorias('TOKEN_DISPOSITIVO_ATIVADO')).filter((l2) => l2.referencia === String(x.id)).length, 0);
    assert.deepEqual([(await a.ativar(app, codigo)).status], [401], 'o mesmo código segue inútil depois');
  });

  test('S5 — consumo do código x nova geração: o código antigo (cancelado pela geração) é 401 genérica e nunca "usado"; o novo segue pendente e é de uso único (200 e depois 401)', async () => {
    const x = await a.dispositivo(a.d.empresaA);
    const antigo = await a.codigoPendente(x);
    const novo = gerarTokenSessao();
    const r = await corrida(x.id, () => a.ativar(app, antigo), async (c) => {
      assert.equal(await ativacaoRepo.cancelarPendentes(c, a.d.empresaA, x.id), 1, 'premissa: a geração real cancela a pendente');
      await ativacaoRepo.inserir(c, { empresaId: a.d.empresaA, dispositivoId: x.id, codigoHash: hashTokenSessao(novo), criadoPor: a.d.master });
    });
    assert.deepEqual([r.status, r.body.codigo], CODIGO_INVALIDO, aviso(r));
    assert.equal(cookieDoTabletNaResposta(r), null);
    assert.equal((await a.linha(x.id)).credencial_hash, null, 'o código antigo não emitiu credencial');
    const [primeira, segunda] = await a.ativacoesDe(x.id);
    assert.ok(primeira.cancelado_em instanceof Date && primeira.usado_em === null, 'o antigo ficou cancelado, não consumido');
    assert.deepEqual([segunda.usado_em, segunda.cancelado_em], [null, null], 'o novo segue pendente');
    const consumo = await a.ativar(app, novo);
    assert.equal(consumo.status, 200, aviso(consumo));
    assert.deepEqual([(await a.ativar(app, novo)).status], [401], 'uso único do código novo');
    assert.equal((await a.ativacoesDe(x.id)).filter((l) => l.usado_em !== null).length, 1);
    assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), [antigo, novo, hashTokenSessao(antigo), hashTokenSessao(novo)]), []);
  });
});
