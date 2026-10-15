'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { montarCenario } = require('./helpers/solicitacao-epi');
const repo = require('../../src/repositories/token-monitoramento.repository');
const eventoRepo = require('../../src/repositories/token-dispositivo-evento.repository');
const servico = require('../../src/services/token-monitoramento.service');
const { JANELA_ESCRITA_MINIMA_SEGUNDOS } = require('../../src/config/token-monitoramento');

/**
 * Atendimento Token — Etapa J, J2a (Fase 3B): repositório e serviço de monitoramento em PostgreSQL real, schema temporário do
 * cluster dedicado, com TODAS as migrations (inclui a 089). Concorrência com conexões independentes e barreiras DETERMINÍSTICAS:
 * um "segurador" mantém a trava de linha numa transação aberta e o teste só avança quando pg_stat_activity mostra a outra
 * conexão realmente esperando a trava; depois libera. Nenhum sleep serve de prova. O relógio do job é injetado (instantes
 * relativos a uma base 48 h no passado); a batida usa o now() do banco. Este arquivo não abre conexão ao ser importado.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const TODAS = fs.readdirSync(DIRETORIO).map((n) => n.match(/^(\d{3})_.*\.sql$/)?.[1]).filter((p) => p !== undefined).sort();
const BASE = Date.now() - 48 * 3600 * 1000;
const em = (segundos) => new Date(BASE + segundos * 1000);
const ms = (data) => data.getTime();

describe('J2a — monitoramento em PostgreSQL real (repositório, serviço e concorrência)', () => {
  let ctx;
  let pool;
  let admin;
  let d;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const usuarioDe = (empresaId) => (empresaId === d.empresaA ? d.solicitante : d.usuarioB);

  async function tablet(empresaId, { contato = 0, registrada = 'ONLINE', suspeita = null, ativado = true, revogado = false } = {}) {
    sequencia += 1;
    const usuario = usuarioDe(empresaId);
    const { rows } = await q(
      `INSERT INTO token_dispositivos (empresa_id, nome, criado_por, ativado_em, revogado_em, revogado_por, ultimo_contato_em, comunicacao_registrada, queda_suspeita_desde)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $3::int END, $6, $7, $8) RETURNING id`,
      [empresaId, `Tablet ${sequencia}`, usuario, ativado, revogado, contato === null ? null : em(contato), contato === null ? null : registrada, suspeita === null ? null : em(suspeita)],
    );
    return { id: rows[0].id, empresaId };
  }
  // atualizado_us: o mesmo instante em texto, com microssegundos. O Date do pg trunca para milissegundos (duas escritas a menos de
  // 1 ms ficam iguais em JavaScript), então a ordem de atualizado_em é conferida no PostgreSQL com aposEstrito.
  const linha = async (t) => (await q('SELECT *, xmin::text AS versao, atualizado_em::text AS atualizado_us FROM token_dispositivos WHERE id = $1', [t.id])).rows[0];
  const aposEstrito = async (posterior, anterior) => (await q('SELECT $1::timestamptz > $2::timestamptz AS ok', [posterior, anterior])).rows[0].ok;
  const ids = (t) => ({ empresaId: t.empresaId, dispositivoId: t.id });
  const eventos = async (t, tipo) => (await q('SELECT * FROM token_dispositivo_eventos WHERE dispositivo_id = $1 AND ($2::text IS NULL OR tipo = $2) ORDER BY id', [t.id, tipo ?? null])).rows;
  const tipos = async (t) => (await eventos(t)).map((e) => e.tipo);
  const instante = (v) => (v === null ? null : ms(v));

  /** Quantas conexões (exceto a de observação) estão esperando uma trava neste banco; espera determinística até haver `n`. */
  async function aguardarEsperas(n) {
    for (let i = 0; i < 1000; i += 1) {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'");
      if (rows[0].n >= n) return rows[0].n;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error(`menos de ${n} conexões esperando trava`);
  }

  /** O segurador `a` executa `segurar` numa transação aberta; `disputar` roda em outra conexão, bloqueia; só então `a` libera. */
  async function concorrer({ segurar, disputar, liberar = 'COMMIT', esperando = 1 }) {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      const resA = await segurar(a);
      const promB = disputar(b);
      await aguardarEsperas(esperando);
      await a.query(liberar);
      return { resA, resB: await promB };
    } catch (erro) {
      await a.query('ROLLBACK').catch(() => {});
      throw erro;
    } finally {
      a.release();
      b.release();
    }
  }

  before(async () => {
    ctx = await abrirPoolTemporario(TODAS);
    pool = ctx.pool;
    admin = await pool.connect();
    d = await montarCenario(admin);
  });
  after(async () => {
    if (admin) admin.release();
    if (ctx) await ctx.encerrar();
  });
  beforeEach(async () => {
    // Só seguro no schema temporário: tira de monitoramento os tablets dos testes anteriores.
    const { rows } = await q("SELECT current_schema() AS s");
    assert.match(rows[0].s, /^test_migration_[0-9a-f]+$/, 'fora do schema temporário');
    await q("UPDATE token_dispositivos SET ultimo_contato_em = NULL, comunicacao_registrada = NULL, queda_suspeita_desde = NULL WHERE current_schema() ~ '^test_migration_[0-9a-f]+$'");
    await q('UPDATE empresas SET ativo = true');
  });

  // ───────────────────────────── 7.1 repositório ─────────────────────────────
  describe('repositório', () => {
    test('listarParaVerificacao: só tablets ativados, não revogados, com contato e empresa ativa; colunas e tipos exatos', async () => {
      const bom = await tablet(d.empresaA, { contato: 10 });
      const pendente = await tablet(d.empresaA, { ativado: false });
      const revogado = await tablet(d.empresaA, { contato: 10, revogado: true });
      const semContato = await tablet(d.empresaA, { contato: null });
      const deB = await tablet(d.empresaB, { contato: 10, suspeita: 5 });
      const lista = await repo.listarParaVerificacao(pool);
      const meus = lista.filter((l) => [bom, pendente, revogado, semContato, deB].some((t) => t.id === l.id));
      assert.deepEqual(meus.map((l) => l.id).sort(), [bom.id, deB.id].sort());
      assert.deepEqual(Object.keys(meus[0]).sort(), ['ativado_em', 'comunicacao_registrada', 'empresa_id', 'id', 'queda_suspeita_desde', 'revogado_em', 'ultimo_contato_em']);
      const b = meus.find((l) => l.id === deB.id);
      assert.equal(typeof b.id, 'number');
      assert.equal(b.empresa_id, d.empresaB);
      assert.ok(b.ultimo_contato_em instanceof Date && b.queda_suspeita_desde instanceof Date && b.ativado_em instanceof Date);
      assert.equal(b.revogado_em, null);
      await q('UPDATE empresas SET ativo = false WHERE id = $1', [d.empresaB]);
      assert.equal((await repo.listarParaVerificacao(pool)).some((l) => l.id === deB.id), false, 'empresa inativa fora');
    });

    test('iniciarSuspeita: grava o instante recebido, só uma vez; não toca contato nem estado; o gatilho atualiza atualizado_em só quando grava', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      const antes = await linha(t);
      assert.equal(await repo.iniciarSuspeita(pool, { ...ids(t), agora: em(300) }), true);
      const depois = await linha(t);
      assert.equal(ms(depois.queda_suspeita_desde), ms(em(300)));
      assert.equal(ms(depois.ultimo_contato_em), ms(antes.ultimo_contato_em));
      assert.equal(depois.comunicacao_registrada, 'ONLINE');
      assert.ok(await aposEstrito(depois.atualizado_us, antes.atualizado_us), 'o gatilho atualizado_em age na escrita (ordem estrita no PostgreSQL, em microssegundos)');
      assert.equal(await repo.iniciarSuspeita(pool, { ...ids(t), agora: em(400) }), false, 'suspeita existente é preservada');
      const preservada = await linha(t);
      assert.equal(ms(preservada.queda_suspeita_desde), ms(em(300)));
      assert.equal(preservada.versao, depois.versao, 'sem linha afetada, sem nova versão da linha');
    });

    test('iniciarSuspeita: silêncio 179 s não; exatamente 180 s sim (inclusivo); contato futuro conta zero', async () => {
      const a = await tablet(d.empresaA, { contato: 0 });
      assert.equal(await repo.iniciarSuspeita(pool, { ...ids(a), agora: em(179) }), false);
      assert.equal(await repo.iniciarSuspeita(pool, { ...ids(a), agora: em(180) }), true);
      const futuro = await tablet(d.empresaA, { contato: 10000 });
      assert.equal(await repo.iniciarSuspeita(pool, { ...ids(futuro), agora: em(300) }), false);
      assert.equal(servico.derivarEstado(await linha(a), em(179)), 'ONLINE');
      assert.equal(servico.derivarEstado(await linha(a), em(180)), 'OFFLINE');
    });

    test('inelegíveis e outra empresa: nenhuma função altera a linha (revogado, pendente, empresa inativa, empresa errada)', async () => {
      const revogado = await tablet(d.empresaA, { contato: 0, revogado: true, suspeita: 100 });
      const pendente = await tablet(d.empresaA, { ativado: false });
      const inativa = await tablet(d.empresaB, { contato: 0, suspeita: 100 });
      await q('UPDATE empresas SET ativo = false WHERE id = $1', [d.empresaB]);
      const certo = await tablet(d.empresaA, { contato: 0, suspeita: 100 });
      for (const t of [revogado, pendente, inativa]) {
        const antes = JSON.stringify(await linha(t));
        assert.equal(await repo.iniciarSuspeita(pool, { ...ids(t), agora: em(900) }), false);
        assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...ids(t), agora: em(900), prazoMaximoSegundos: 300 }), false);
        assert.equal(await repo.confirmarQueda(pool, { ...ids(t), agora: em(300) }), false);
        assert.equal(JSON.stringify(await linha(t)), antes, `tablet ${t.id} inalterado`);
      }
      // empresa trocada: o id é do tablet da A, a empresa informada é a B
      const antes = JSON.stringify(await linha(certo));
      const errado = { empresaId: d.empresaB, dispositivoId: certo.id };
      assert.equal(await repo.iniciarSuspeita(pool, { ...errado, agora: em(900) }), false);
      assert.equal(await repo.descartarSuspeita(pool, errado), false);
      assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...errado, agora: em(900), prazoMaximoSegundos: 300 }), false);
      assert.equal(await repo.confirmarQueda(pool, { ...errado, agora: em(300) }), false);
      assert.equal(await repo.travarParaContato(pool, errado), null);
      assert.equal(await repo.gravarContato(pool, { ...errado, janelaSegundos: 45 }), false);
      assert.equal((await servico.registrarContato(pool, errado)).gravou, false);
      assert.equal(JSON.stringify(await linha(certo)), antes, 'o tablet da empresa A não foi tocado por uma chamada da empresa B');
    });

    test('descartarSuspeita: limpa só a suspeita do tablet, idempotente, sem tocar contato, estado nem eventos', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 100 });
      const outro = await tablet(d.empresaA, { contato: 0, suspeita: 100 });
      assert.equal(await repo.descartarSuspeita(pool, ids(t)), true);
      assert.equal(await repo.descartarSuspeita(pool, ids(t)), false);
      const l = await linha(t);
      assert.equal(l.queda_suspeita_desde, null);
      assert.equal(ms(l.ultimo_contato_em), ms(em(0)));
      assert.equal((await linha(outro)).queda_suspeita_desde !== null, true);
      assert.deepEqual(await tipos(t), []);
    });

    test('reiniciarSuspeitaExpirada: 299 e 300 s válidas (não reinicia); 301 s expirada (reinicia); futura preservada; infinita e superada por contato reiniciam', async () => {
      const casos = [['299 s', 200, 499, false], ['300 s', 200, 500, false], ['301 s', 200, 501, true], ['futura (50 ms adiante)', 600, null, false]];
      for (const [rotulo, suspeita, agoraS, reinicia] of casos) {
        const t = await tablet(d.empresaA, { contato: 0, suspeita });
        const agora = agoraS === null ? new Date(ms(em(600)) - 50) : em(agoraS);
        assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...ids(t), agora, prazoMaximoSegundos: 300 }), reinicia, rotulo);
        const l = await linha(t);
        assert.equal(ms(l.queda_suspeita_desde), reinicia ? ms(agora) : ms(em(suspeita)), `${rotulo}: instante da suspeita`);
        assert.equal(l.comunicacao_registrada, 'ONLINE');
        assert.deepEqual(await tipos(t), [], `${rotulo}: nenhum evento`);
      }
      const infinita = await tablet(d.empresaA, { contato: 0, suspeita: 100 });
      await q("UPDATE token_dispositivos SET queda_suspeita_desde = 'infinity' WHERE id = $1", [infinita.id]);
      assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...ids(infinita), agora: em(700), prazoMaximoSegundos: 300 }), true);
      assert.equal(ms((await linha(infinita)).queda_suspeita_desde), ms(em(700)));
      const superada = await tablet(d.empresaA, { contato: 150, suspeita: 100 });
      assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...ids(superada), agora: em(400), prazoMaximoSegundos: 300 }), true, 'contato posterior à suspeita e silêncio de 250 s');
      const recente = await tablet(d.empresaA, { contato: 350, suspeita: 100 });
      assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...ids(recente), agora: em(400), prazoMaximoSegundos: 300 }), false, 'silêncio de 50 s: não reinicia');
      const offline = await tablet(d.empresaA, { contato: 0, suspeita: 100, registrada: 'OFFLINE' });
      assert.equal(await repo.reiniciarSuspeitaExpirada(pool, { ...ids(offline), agora: em(900), prazoMaximoSegundos: 300 }), false, 'QUEDA já registrada');
      await assert.rejects(repo.reiniciarSuspeitaExpirada(pool, { ...ids(offline), agora: em(900), prazoMaximoSegundos: 0 }), TypeError);
    });

    test('confirmarQueda: 89 s não; 90 e 300 s sim; 301 s não; futura não; superada por contato não; silêncio 179 s não', async () => {
      const tentativa = async (contato, suspeita, agoraMs, prazo = 300) => {
        const t = await tablet(d.empresaA, { contato, suspeita });
        const r = await repo.confirmarQueda(pool, { ...ids(t), agora: new Date(agoraMs), idadeMaximaSegundos: prazo });
        return { t, r };
      };
      assert.equal((await tentativa(0, 200, ms(em(289)))).r, false, '89 s');
      const a90 = await tentativa(0, 200, ms(em(290)));
      assert.equal(a90.r, true, '90 s');
      const l = await linha(a90.t);
      assert.equal(l.comunicacao_registrada, 'OFFLINE');
      assert.equal(l.queda_suspeita_desde, null);
      assert.equal(ms(l.ultimo_contato_em), ms(em(0)), 'o contato não é alterado');
      assert.equal((await tentativa(0, 200, ms(em(500)))).r, true, '300 s');
      assert.equal((await tentativa(0, 200, ms(em(501)))).r, false, '301 s');
      assert.equal((await tentativa(0, 600, ms(em(600)) - 50)).r, false, 'futura');
      assert.equal((await tentativa(150, 100, ms(em(400)))).r, false, 'superada por contato');
      assert.equal((await tentativa(100, 150, ms(em(279)))).r, false, 'silêncio de 179 s');
      assert.equal((await tentativa(100, 150, ms(em(280)))).r, true, 'silêncio de 180 s, suspeita com 130 s');
      assert.equal((await tentativa(0, 200, ms(em(501)), null)).r, true, 'sem prazo máximo informado a capacidade antiga continua');
    });

    test('batida (registrarContato): primeiro contato sem evento; janela de 45 s sem regravar; 50 s regrava; cancela suspeita; revogado não grava', async () => {
      const t = await tablet(d.empresaA, { contato: null });
      assert.deepEqual(await servico.registrarContato(pool, ids(t)), { gravou: true, restabelecido: false });
      const c1 = await linha(t);
      assert.equal(c1.comunicacao_registrada, 'ONLINE');
      assert.deepEqual(await tipos(t), []);
      assert.deepEqual(await servico.registrarContato(pool, ids(t)), { gravou: false, restabelecido: false });
      assert.equal((await linha(t)).versao, c1.versao, 'batida imediata não regrava a linha');
      await q("UPDATE token_dispositivos SET ultimo_contato_em = now() - make_interval(secs => $2) WHERE id = $1", [t.id, JANELA_ESCRITA_MINIMA_SEGUNDOS - 5]);
      const c2 = await linha(t);
      assert.equal((await servico.registrarContato(pool, ids(t))).gravou, false, '40 s: dentro da janela');
      assert.equal((await linha(t)).versao, c2.versao);
      await q("UPDATE token_dispositivos SET ultimo_contato_em = now() - interval '50 seconds' WHERE id = $1", [t.id]);
      const c3 = await linha(t);
      assert.equal((await servico.registrarContato(pool, ids(t))).gravou, true, '50 s: regrava');
      const c4 = await linha(t);
      assert.notEqual(c4.versao, c3.versao);
      assert.ok(c4.ultimo_contato_em > c3.ultimo_contato_em, 'o contato avança');
      assert.ok(await aposEstrito(c4.atualizado_us, c3.atualizado_us), 'atualizado_em avança (ordem estrita no PostgreSQL, em microssegundos)');
      const comSuspeita = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      assert.equal((await servico.registrarContato(pool, ids(comSuspeita))).gravou, true);
      assert.equal((await linha(comSuspeita)).queda_suspeita_desde, null, 'a batida cancela a suspeita');
      const revogado = await tablet(d.empresaA, { contato: 0, revogado: true });
      const antes = JSON.stringify(await linha(revogado));
      assert.equal((await servico.registrarContato(pool, ids(revogado))).gravou, false);
      assert.equal(JSON.stringify(await linha(revogado)), antes);
    });

    test('RESTABELECIMENTO: duração = silêncio real (do contato anterior até agora), inteira e não negativa; um só evento', async () => {
      const t = await tablet(d.empresaA, { contato: 0, registrada: 'OFFLINE' });
      await q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo) VALUES ($1, $2, 'QUEDA')", [t.empresaId, t.id]);
      const r = await servico.registrarContato(pool, ids(t));
      assert.deepEqual(r, { gravou: true, restabelecido: true });
      const rest = await eventos(t, 'RESTABELECIMENTO');
      assert.equal(rest.length, 1);
      assert.equal(rest[0].empresa_id, t.empresaId);
      assert.equal(rest[0].usuario_id, null);
      const esperado = Math.floor((Date.now() - BASE) / 1000);
      assert.ok(Number.isInteger(rest[0].duracao_segundos) && Math.abs(rest[0].duracao_segundos - esperado) < 30, `duração ${rest[0].duracao_segundos} ~ ${esperado}`);
      assert.equal((await linha(t)).comunicacao_registrada, 'ONLINE');
    });
  });

  // ───────────────────────────── 7.2 concorrência real ─────────────────────────────
  describe('concorrência real (duas ou mais conexões, barreira determinística)', () => {
    test('C1 — dois jobs iniciando a mesma suspeita: só o primeiro grava; o segundo não a desloca', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      const { resA, resB } = await concorrer({
        segurar: (a) => repo.iniciarSuspeita(a, { ...ids(t), agora: em(300) }),
        disputar: (b) => repo.iniciarSuspeita(b, { ...ids(t), agora: em(310) }),
      });
      assert.deepEqual([resA, resB], [true, false]);
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(em(300)));
      assert.deepEqual(await tipos(t), []);
    });

    test('C2 — dois jobs reiniciando a suspeita expirada: só o primeiro reinicia; o segundo reavalia e não desloca', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const { resA, resB } = await concorrer({
        segurar: (a) => repo.reiniciarSuspeitaExpirada(a, { ...ids(t), agora: em(600), prazoMaximoSegundos: 300 }),
        disputar: (b) => repo.reiniciarSuspeitaExpirada(b, { ...ids(t), agora: em(605), prazoMaximoSegundos: 300 }),
      });
      assert.deepEqual([resA, resB], [true, false]);
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(em(600)));
      assert.deepEqual(await tipos(t), []);
    });

    test('C3 — o segundo job com o relógio ALGUNS MILISSEGUNDOS ATRÁS: a suspeita recém-criada não é reiniciada nem confirma', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const atrasado = new Date(ms(em(600)) - 50);
      const { resA, resB } = await concorrer({
        segurar: (a) => repo.reiniciarSuspeitaExpirada(a, { ...ids(t), agora: em(600), prazoMaximoSegundos: 300 }),
        disputar: (b) => repo.reiniciarSuspeitaExpirada(b, { ...ids(t), agora: atrasado, prazoMaximoSegundos: 300 }),
      });
      assert.deepEqual([resA, resB], [true, false]);
      assert.equal(await repo.confirmarQueda(pool, { ...ids(t), agora: atrasado, idadeMaximaSegundos: 300 }), false, 'a suspeita futura não confirma');
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(em(600)), 'a primeira observação do primeiro job foi preservada');
      const passagem = await servico.verificarComunicacao(pool, { relogio: () => atrasado, sonda: async () => true });
      assert.equal(passagem.suspeitasFuturas, 1);
      assert.equal(passagem.quedas, 0);
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(em(600)));
      assert.deepEqual(await tipos(t), []);
    });

    test('C4 — batida concorrente com o início da suspeita: a suspeita não nasce com base no estado antigo', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      const { resA, resB } = await concorrer({
        segurar: async (a) => { await repo.travarParaContato(a, ids(t)); return repo.gravarContato(a, { ...ids(t), janelaSegundos: 45 }); },
        disputar: (b) => repo.iniciarSuspeita(b, { ...ids(t), agora: em(300) }),
      });
      assert.deepEqual([resA, resB], [true, false]);
      const l = await linha(t);
      assert.equal(l.queda_suspeita_desde, null);
      assert.ok(ms(l.ultimo_contato_em) > BASE + 3600 * 1000, 'o contato é o da batida');
    });

    test('C5a — batida concorrente com o reinício: o reinício com visão antiga não cria suspeita', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const { resB } = await concorrer({
        segurar: async (a) => { await repo.travarParaContato(a, ids(t)); return repo.gravarContato(a, { ...ids(t), janelaSegundos: 45 }); },
        disputar: (b) => repo.reiniciarSuspeitaExpirada(b, { ...ids(t), agora: em(600), prazoMaximoSegundos: 300 }),
      });
      assert.equal(resB, false);
      assert.equal((await linha(t)).queda_suspeita_desde, null);
    });

    test('C5b — reinício primeiro, batida depois: a batida cancela a suspeita recém-reiniciada, sem evento', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const { resA, resB } = await concorrer({
        segurar: (a) => repo.reiniciarSuspeitaExpirada(a, { ...ids(t), agora: em(600), prazoMaximoSegundos: 300 }),
        disputar: (b) => servico.registrarContato(pool, ids(t)),
      });
      assert.equal(resA, true);
      assert.deepEqual(resB, { gravou: true, restabelecido: false });
      assert.equal((await linha(t)).queda_suspeita_desde, null);
      assert.deepEqual(await tipos(t), []);
    });

    test('C6a — batida concorrente com a confirmação: a QUEDA não é registrada com base no contato antigo', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const { resB } = await concorrer({
        segurar: async (a) => { await repo.travarParaContato(a, ids(t)); return repo.gravarContato(a, { ...ids(t), janelaSegundos: 45 }); },
        disputar: (b) => repo.confirmarQueda(b, { ...ids(t), agora: em(300), idadeMaximaSegundos: 300 }),
      });
      assert.equal(resB, false);
      assert.deepEqual(await tipos(t), []);
      assert.equal((await linha(t)).comunicacao_registrada, 'ONLINE');
    });

    test('C6b — confirmação primeiro, batida depois: QUEDA e depois UM RESTABELECIMENTO, nesta ordem', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const { resA, resB } = await concorrer({
        segurar: async (a) => { const ok = await repo.confirmarQueda(a, { ...ids(t), agora: em(300), idadeMaximaSegundos: 300 }); if (ok) await eventoRepo.registrar(a, { ...ids(t), tipo: 'QUEDA' }); return ok; },
        disputar: () => servico.registrarContato(pool, ids(t)),
      });
      assert.equal(resA, true);
      assert.deepEqual(resB, { gravou: true, restabelecido: true });
      assert.deepEqual(await tipos(t), ['QUEDA', 'RESTABELECIMENTO']);
      assert.equal((await linha(t)).comunicacao_registrada, 'ONLINE');
    });

    test('C7 — duas confirmações simultâneas: exatamente UMA queda e UM evento', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const { resA, resB } = await concorrer({
        segurar: async (a) => { const ok = await repo.confirmarQueda(a, { ...ids(t), agora: em(300), idadeMaximaSegundos: 300 }); if (ok) await eventoRepo.registrar(a, { ...ids(t), tipo: 'QUEDA' }); return ok; },
        disputar: (b) => repo.confirmarQueda(b, { ...ids(t), agora: em(300), idadeMaximaSegundos: 300 }),
      });
      assert.deepEqual([resA, resB], [true, false]);
      assert.deepEqual(await tipos(t), ['QUEDA']);
      assert.equal((await linha(t)).comunicacao_registrada, 'OFFLINE');
    });

    test('C7b — quatro passagens completas do serviço presas na mesma trava: uma só QUEDA no total', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const a = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [t.id]);
        const passagens = Array.from({ length: 4 }, () => servico.verificarComunicacao(pool, { relogio: () => em(300), sonda: async () => true }));
        await aguardarEsperas(4);
        await a.query('ROLLBACK');
        const resultados = await Promise.all(passagens);
        assert.equal(resultados.reduce((s, r) => s + r.quedas, 0), 1);
      } finally {
        await a.query('ROLLBACK').catch(() => {});
        a.release();
      }
      assert.deepEqual(await tipos(t), ['QUEDA']);
    });

    test('C8 — cinco primeiras batidas simultâneas de um tablet OFFLINE: exatamente UM RESTABELECIMENTO', async () => {
      const t = await tablet(d.empresaA, { contato: 0, registrada: 'OFFLINE' });
      await q("INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo) VALUES ($1, $2, 'QUEDA')", [t.empresaId, t.id]);
      const a = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', [t.id]);
        const batidas = Array.from({ length: 5 }, () => servico.registrarContato(pool, ids(t)));
        await aguardarEsperas(5);
        await a.query('ROLLBACK');
        const resultados = await Promise.all(batidas);
        assert.equal(resultados.filter((r) => r.restabelecido).length, 1);
        assert.equal(resultados.filter((r) => r.gravou).length, 1, 'só a primeira grava; as demais veem o contato recente');
      } finally {
        await a.query('ROLLBACK').catch(() => {});
        a.release();
      }
      assert.deepEqual(await tipos(t), ['QUEDA', 'RESTABELECIMENTO']);
    });

    test('C9 — falha antes do COMMIT: ROLLBACK integral (estado, suspeita e eventos intactos), manual e por falha injetada no evento', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const antes = JSON.stringify(await linha(t));
      const a = await pool.connect();
      try {
        await a.query('BEGIN');
        assert.equal(await repo.confirmarQueda(a, { ...ids(t), agora: em(300), idadeMaximaSegundos: 300 }), true);
        await eventoRepo.registrar(a, { ...ids(t), tipo: 'QUEDA' });
        await a.query('ROLLBACK');
      } finally { a.release(); }
      assert.equal(JSON.stringify(await linha(t)), antes);
      assert.deepEqual(await tipos(t), []);
      const poolFalho = {
        query: (...argumentos) => pool.query(...argumentos),
        connect: async () => {
          const c = await pool.connect();
          return { query: (sql, ...resto) => (String(sql).startsWith('INSERT INTO token_dispositivo_eventos') ? Promise.reject(new Error('falha injetada')) : c.query(sql, ...resto)), release: () => c.release() };
        },
      };
      await assert.rejects(servico.verificarComunicacao(poolFalho, { relogio: () => em(300), sonda: async () => true }), /falha injetada/);
      assert.equal(JSON.stringify(await linha(t)), antes, 'a confirmação foi desfeita junto com o evento que falhou');
      assert.deepEqual(await tipos(t), []);
    });
  });

  // ───────────────────────────── 7.3 cenários temporais pelo serviço ─────────────────────────────
  describe('cenários temporais (passagem do serviço, relógio injetado)', () => {
    const passar = (segundos) => servico.verificarComunicacao(pool, { relogio: () => em(segundos), sonda: async () => true });

    test('179 s não abre suspeita; 180 s abre a primeira observação sem QUEDA', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      await passar(179);
      assert.equal((await linha(t)).queda_suspeita_desde, null);
      const r = await passar(180);
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(em(180)));
      assert.equal(r.quedas, 0);
      assert.deepEqual(await tipos(t), []);
    });

    test('suspeita com 89 s não confirma; com 90 s confirma UMA queda e não repete', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      await passar(200);
      await passar(289);
      assert.deepEqual(await tipos(t), []);
      assert.equal((await passar(290)).quedas, 1);
      await passar(350);
      await passar(900);
      assert.deepEqual(await tipos(t), ['QUEDA']);
      assert.equal((await linha(t)).queda_suspeita_desde, null);
    });

    test('suspeita com 299 e 300 s é válida e confirma; com mais de 300 s expira e reinicia sem QUEDA', async () => {
      const a = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      assert.equal((await passar(499)).quedas, 1, '299 s');
      assert.deepEqual(await tipos(a), ['QUEDA']);
      const b = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      assert.equal((await passar(500)).quedas, 1, '300 s');
      assert.deepEqual(await tipos(b), ['QUEDA']);
      const c = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      assert.equal((await passar(501)).quedas, 0, '301 s');
      assert.equal(ms((await linha(c)).queda_suspeita_desde), ms(em(501)), 'recomeço como nova primeira observação');
      assert.deepEqual(await tipos(c), []);
      assert.equal((await linha(c)).comunicacao_registrada, 'ONLINE');
      assert.equal(ms((await linha(c)).ultimo_contato_em), ms(em(0)), 'o contato nunca é alterado');
    });

    test('primeira observação TARDIA (silêncio de 5000 s) não confirma; 95 s depois confirma UMA queda (E14)', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      await passar(5000);
      assert.deepEqual(await tipos(t), []);
      assert.equal((await passar(5095)).quedas, 1);
      await passar(5200);
      assert.deepEqual(await tipos(t), ['QUEDA']);
    });

    test('retomada após interrupção prolongada: a suspeita antiga recomeça sem QUEDA; a confirmação vem só 90 s depois', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const r1 = await passar(5000);
      assert.equal(r1.quedas, 0);
      assert.deepEqual(await tipos(t), []);
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(em(5000)));
      assert.equal((await passar(5060)).quedas, 0, '60 s depois ainda em confirmação');
      assert.equal((await passar(5090)).quedas, 1, '90 s depois da nova primeira observação');
    });

    test('suspeita futura por pequena diferença de relógio: preservada, não confirma, não reinicia sucessivamente', async () => {
      const t = await tablet(d.empresaA, { contato: 0 });
      await passar(1000);
      const antes = (await linha(t)).queda_suspeita_desde;
      for (let i = 0; i < 3; i += 1) {
        const r = await servico.verificarComunicacao(pool, { relogio: () => new Date(ms(em(1000)) - 50 - i), sonda: async () => true });
        assert.equal(r.quedas, 0);
        assert.equal(r.suspeitasFuturas, 1);
      }
      assert.equal(ms((await linha(t)).queda_suspeita_desde), ms(antes));
      assert.deepEqual(await tipos(t), []);
    });

    test('contato posterior à suspeita impede a confirmação: silêncio curto descarta; silêncio longo recomeça sem QUEDA', async () => {
      const curto = await tablet(d.empresaA, { contato: 221, suspeita: 181 });
      await passar(276);
      assert.equal((await linha(curto)).queda_suspeita_desde, null);
      const longo = await tablet(d.empresaA, { contato: 200, suspeita: 181 });
      const r = await passar(381);
      assert.equal(r.quedas, 0);
      assert.equal(ms((await linha(longo)).queda_suspeita_desde), ms(em(381)));
      assert.equal((await passar(476)).quedas, 1, '95 s depois da nova primeira observação');
      assert.deepEqual(await tipos(longo), ['QUEDA']);
      assert.deepEqual(await tipos(curto), []);
    });

    test('revogado, não ativado, sem contato, empresa inativa e já OFFLINE não geram suspeita nem transição', async () => {
      const revogado = await tablet(d.empresaA, { contato: 0, revogado: true });
      const pendente = await tablet(d.empresaA, { contato: 0, ativado: false });
      const nunca = await tablet(d.empresaA, { contato: null });
      const inativa = await tablet(d.empresaB, { contato: 0 });
      await q('UPDATE empresas SET ativo = false WHERE id = $1', [d.empresaB]);
      const offline = await tablet(d.empresaA, { contato: 0, registrada: 'OFFLINE' });
      await passar(300);
      await passar(400);
      for (const t of [revogado, pendente, nunca, inativa, offline]) {
        assert.equal((await linha(t)).queda_suspeita_desde, null, `tablet ${t.id}`);
        assert.deepEqual(await tipos(t), []);
      }
    });

    test('sonda reprovada: aborta, invalida as suspeitas e não escreve contato, estado nem eventos; inconclusiva não escreve nada', async () => {
      const t = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const antes = await linha(t);
      const inconclusiva = await servico.verificarComunicacao(pool, { relogio: () => em(300), sonda: async () => { throw new Error('rede'); } });
      assert.equal(inconclusiva.motivo, 'SONDA_INCONCLUSIVA');
      assert.equal((await linha(t)).versao, antes.versao, 'inconclusiva: nenhuma escrita');
      const reprovada = await servico.verificarComunicacao(pool, { relogio: () => em(300), sonda: async () => false });
      assert.deepEqual([reprovada.abortada, reprovada.quedas, reprovada.motivo], [true, 0, 'SONDA_FALHOU']);
      assert.ok(reprovada.suspeitasInvalidadas >= 1);
      const depois = await linha(t);
      assert.equal(depois.queda_suspeita_desde, null);
      assert.equal(ms(depois.ultimo_contato_em), ms(antes.ultimo_contato_em));
      assert.equal(depois.comunicacao_registrada, antes.comunicacao_registrada);
      assert.deepEqual(await tipos(t), []);
    });
  });

  // ───────────────────────────── 7.4 multiempresa ─────────────────────────────
  describe('isolamento multiempresa', () => {
    test('uma passagem com tablets das duas empresas grava cada evento com a empresa do próprio tablet; o saudável não é tocado', async () => {
      const mudoA = await tablet(d.empresaA, { contato: 0, suspeita: 200 });
      const mudoB = await tablet(d.empresaB, { contato: 0, suspeita: 200 });
      const saudavelA = await tablet(d.empresaA, { contato: 250 });
      const antesSaudavel = JSON.stringify(await linha(saudavelA));
      const r = await servico.verificarComunicacao(pool, { relogio: () => em(300), sonda: async () => true });
      assert.equal(r.quedas, 2);
      assert.equal((await eventos(mudoA, 'QUEDA'))[0].empresa_id, d.empresaA);
      assert.equal((await eventos(mudoB, 'QUEDA'))[0].empresa_id, d.empresaB);
      assert.equal(JSON.stringify(await linha(saudavelA)), antesSaudavel);
      const todosDeA = (await q('SELECT dispositivo_id FROM token_dispositivo_eventos WHERE empresa_id = $1', [d.empresaA])).rows.map((x) => x.dispositivo_id);
      assert.equal(todosDeA.includes(mudoB.id), false);
    });

    test('a listagem abrangente é só uma função de repositório: nenhuma rota ou controller a referencia', async () => {
      const raiz = path.join(__dirname, '..', '..', 'src');
      const achados = [];
      for (const pasta of ['routes', 'controllers']) {
        for (const arquivo of fs.readdirSync(path.join(raiz, pasta))) {
          const texto = fs.readFileSync(path.join(raiz, pasta, arquivo), 'utf8');
          if (/listarParaVerificacao|descartarTodasAsSuspeitas/.test(texto)) achados.push(`${pasta}/${arquivo}`);
        }
      }
      assert.deepEqual(achados, []);
    });
  });
});
