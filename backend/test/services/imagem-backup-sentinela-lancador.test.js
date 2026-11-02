'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): LANÇADOR DE SENTINELAS (lado do runner). Faz o papel do `spawn` que a composição de produção já aceita por injeção (`portas.spawn`) e do `observarGrupo`, de modo que os lançadores e o supervisor existentes
 * continuem iguais: o que o runner recebe é o ChildProcess REAL da sentinela (com os mesmos fluxos), cujo `kill` fala com a sentinela pelo canal restrito. Aqui o `child_process.spawn` é substituído por um dublê (nenhum processo real); a prova com processos reais está em
 * `imagem-backup-supervisao-integrada.test.js`.
 *
 * Contrato (módulo `src/services/imagem-backup-sentinela-lancador.service`):
 *   criarSupervisorDeProcessos({ raiz, tentativaId, diario, scriptDaSentinela, execPath?, temporizador?, cortesiaMs?, esperaPosKillMs?, grupo?, spawnDoNode? })
 *     -> { spawn(comando, args, opcoes), observarGrupo(pgid), suspender(), encerrarClientes({ cortesiaMs?, esperaMs? }), situacao() }
 *   - a INTENÇÃO (INTENCAO_LANCAMENTO) é sincronizada ANTES do spawn da sentinela; sem diário durável nada é lançado; spawn que lança é falha de início comprovada (NAO_INICIADO);
 *   - o handle devolvido tem o `kill` redirecionado: SIGINT/SIGTERM -> PARAR, SIGKILL -> ESCALAR (só ao CLIENTE, pela sentinela); nunca sinal do sistema operacional para a sentinela;
 *   - `observarGrupo` responde pelo diário da sentinela (GRUPO_VERIFICADO), nunca por consulta de PID; sem registro vale "não confirmado" (lança);
 *   - `suspender()` impede novos lançamentos; `encerrarClientes()` pede a parada de todos os vivos e só afirma ENCERRADOS com saída observada E grupo comprovadamente vazio.
 */

const MODULO = 'src/services/imagem-backup-sentinela-lancador.service';
const modulo = () => exigirModulo(MODULO);
const diarioModulo = () => exigirModulo('src/services/imagem-backup-diario-execucao.service');
const portas = () => exigirModulo('src/services/imagem-backup-portas-sistema.service');
const SCRIPT = '/opt/sintetico/sentinela.worker.js';
const SEGREDO_NO_ARGUMENTO = 'SEGREDO-NUNCA-NO-DIARIO-987';

let base;
before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-lancador-'))); fs.chmodSync(base, 0o700); });
after(() => { fs.rmSync(base, { recursive: true, force: true }); });
let contador = 0;

const tick = () => new Promise((r) => setImmediate(r));
async function tiques(n = 4) { for (let i = 0; i < n; i += 1) await tick(); }

function temporizadorManual() {
  let agora = 0;
  const pend = [];
  const prazo = (ms) => {
    let res;
    const promessa = new Promise((r) => { res = r; });
    const item = { vence: agora + ms, res, ativo: true };
    pend.push(item);
    return { promessa, cancelar() { item.ativo = false; } };
  };
  return { prazo, intervalo: (ms) => prazo(ms).promessa, async avancar(ms) { agora += ms; for (const i of pend) if (i.ativo && i.vence <= agora) { i.ativo = false; i.res(); } await tiques(); } };
}

class SentinelaFalsa extends EventEmitter {
  constructor(pid = 7001) {
    super();
    this.pid = pid;
    this.connected = true;
    this.enviadas = [];
    this.stdout = { id: 'stdout' };
    this.stderr = { id: 'stderr' };
  }

  send(m) { this.enviadas.push(m); return true; }
  kill() { throw new Error('o runner nunca sinaliza a sentinela pelo sistema operacional'); }
  sair(codigo, sinal = null) { this.emit('exit', codigo, sinal); this.emit('close', codigo, sinal); }
}

function cenario({ spawnDoNode, diarioFalha = null, extra = {} } = {}) {
  contador += 1;
  const raiz = path.join(base, `estado-${contador}`);
  fs.mkdirSync(raiz, { mode: 0o700 });
  const d = diarioModulo();
  const runner = d.iniciarTentativa({ raiz, tentativaId: 't-0001', runnerPid: process.pid });
  const ordem = [];
  const diario = Object.freeze({
    registrar(tipo, dados) {
      ordem.push(`diario:${tipo}`);
      if (diarioFalha !== null && diarioFalha(tipo)) throw Object.assign(new Error('x'), { code: 'DIARIO_NAO_DURAVEL' });
      return runner.registrar(tipo, dados);
    },
  });
  const sentinelas = [];
  const chamadas = [];
  const padrao = (...args) => { ordem.push('spawn-node'); chamadas.push(args); const s = new SentinelaFalsa(7001 + sentinelas.length); sentinelas.push(s); return s; };
  const tempo = temporizadorManual();
  const supervisor = modulo().criarSupervisorDeProcessos({ raiz, tentativaId: 't-0001', diario, scriptDaSentinela: SCRIPT, execPath: '/opt/sintetico/node', temporizador: tempo, spawnDoNode: spawnDoNode ?? padrao, ...extra });
  const lerRunner = () => d.lerTentativa({ raiz, tentativaId: 't-0001' }).escritores.runner.eventos;
  return { supervisor, sentinelas, chamadas, ordem, tempo, raiz, lerRunner, runner };
}

const ARGS = ['--format=custom', '--no-password', `--dbname=${SEGREDO_NO_ARGUMENTO}`];
const ENV = Object.freeze({ PGPASSFILE: '/x/pgpass', PGHOST: '/x/s', PGPORT: '55433', PGUSER: 'gepi_hom' });
const OPCOES = () => ({ env: { ...ENV }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

describe('LS — lançamento: intenção antes, identidade depois, nada além', () => {
  test('LS-01 — a INTENÇÃO é gravada ANTES do spawn da sentinela e só depois vem SENTINELA_LANCADA; o diário NÃO contém argumentos nem segredo (só contagem e hash)', () => {
    const c = cenario();
    c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    assert.deepEqual(c.ordem, ['diario:INTENCAO_LANCAMENTO', 'spawn-node', 'diario:SENTINELA_LANCADA']);
    const ev = c.lerRunner();
    assert.deepEqual(ev.map((e) => e.k), ['TENTATIVA_INICIADA', 'INTENCAO_LANCAMENTO', 'SENTINELA_LANCADA']);
    assert.equal(ev[1].d.papel, 'pg_dump');
    assert.equal(ev[1].d.executavel, 'pg_dump');
    assert.equal(ev[1].d.nArgs, 3);
    assert.equal(ev[2].d.sentinelaPid, 7001);
    const bruto = fs.readFileSync(path.join(c.raiz, 'tentativas', 't-0001', 'runner.ndjson'), 'utf8');
    for (const proibido of [SEGREDO_NO_ARGUMENTO, '/x/pgpass', 'gepi_hom', '--dbname']) assert.equal(bruto.includes(proibido), false, proibido);
  });

  test('LS-02 — a sentinela nasce com o executável do Node, o script e a configuração (base64) e opções detached:true, shell:false, os mesmos fluxos mais o canal IPC; o ambiente do cliente é repassado; id e token são aleatórios', () => {
    const c = cenario();
    const filho = c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    const [exe, args, op] = c.chamadas[0];
    assert.equal(exe, '/opt/sintetico/node');
    assert.equal(args[0], SCRIPT);
    assert.equal(args.length, 2);
    assert.deepEqual(op.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
    assert.equal(op.shell, false);
    assert.equal(op.detached, true);
    assert.deepEqual(op.env, ENV);
    const cfg = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
    assert.equal(cfg.v, 1);
    assert.equal(cfg.raiz, c.raiz);
    assert.equal(cfg.tentativaId, 't-0001');
    assert.match(cfg.lancamentoId, /^[0-9a-f]{32}$/);
    assert.match(cfg.token, /^[0-9a-f]{32}$/);
    assert.notEqual(cfg.lancamentoId, cfg.token);
    assert.equal(cfg.comando, '/opt/postgres/bin/pg_dump');
    assert.deepEqual(cfg.argumentos, ARGS);
    assert.equal(filho, c.sentinelas[0]);
    assert.equal(filho.stdout.id, 'stdout');
    const c2 = cenario();
    c2.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    assert.notEqual(JSON.parse(Buffer.from(c2.chamadas[0][1][1], 'base64').toString('utf8')).token, cfg.token);
  });

  test('LS-03 — (cenário 11) diário não durável na intenção: NADA é lançado e o erro sobe; spawn que lança é falha de início COMPROVADA e fica registrada (LANCAMENTO_NAO_INICIADO)', () => {
    const c = cenario({ diarioFalha: (t) => t === 'INTENCAO_LANCAMENTO' });
    assert.throws(() => c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES()), (e) => e.code === 'DIARIO_NAO_DURAVEL');
    assert.equal(c.chamadas.length, 0);
    const d = cenario({ spawnDoNode: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
    assert.throws(() => d.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES()), (e) => e.code === 'EACCES');
    const ev = d.lerRunner();
    assert.deepEqual(ev.map((e) => e.k), ['TENTATIVA_INICIADA', 'INTENCAO_LANCAMENTO', 'LANCAMENTO_NAO_INICIADO']);
  });

  test('LS-04 — erro assíncrono sem pid (ENOENT) registra LANCAMENTO_NAO_INICIADO; erro COM pid não prova nada e não registra "não iniciado"', async () => {
    const semPid = new SentinelaFalsa(null);
    const c = cenario({ spawnDoNode: () => semPid });
    c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    semPid.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    await tiques();
    assert.ok(c.lerRunner().some((e) => e.k === 'LANCAMENTO_NAO_INICIADO'));
    const comPid = new SentinelaFalsa(7010);
    const d = cenario({ spawnDoNode: () => comPid });
    d.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    comPid.emit('error', new Error('x'));
    await tiques();
    assert.equal(d.lerRunner().some((e) => e.k === 'LANCAMENTO_NAO_INICIADO'), false);
  });

  test('LS-05 — opções fora do contrato dos lançadores são recusadas ANTES da intenção: shell/detached errados, stdio fora de 3 posições, comando relativo, env com valor não texto, chave extra', () => {
    const c = cenario();
    const ruins = [
      ['/opt/pg_dump', ARGS, { ...OPCOES(), shell: true }],
      ['/opt/pg_dump', ARGS, { ...OPCOES(), detached: false }],
      ['/opt/pg_dump', ARGS, { ...OPCOES(), stdio: ['ignore', 'pipe'] }],
      ['/opt/pg_dump', ARGS, { ...OPCOES(), env: { PGUSER: 1 } }],
      ['/opt/pg_dump', ARGS, { ...OPCOES(), extra: true }],
      ['pg_dump', ARGS, OPCOES()],
      ['/opt/pg_dump', [1], OPCOES()],
    ];
    for (const r of ruins) assert.throws(() => c.supervisor.spawn(...r), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.equal(c.ordem.length, 0);
    assert.equal(c.chamadas.length, 0);
  });
});

describe('LS — o kill do handle fala com a sentinela, nunca com o sistema operacional', () => {
  test('LS-10 — SIGINT/SIGTERM viram PARAR e SIGKILL vira ESCALAR (canal e token do lançamento); sinal fora do contrato ou canal desconectado devolvem false; o kill do SO da sentinela nunca é chamado', () => {
    const c = cenario();
    const filho = c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    const cfg = JSON.parse(Buffer.from(c.chamadas[0][1][1], 'base64').toString('utf8'));
    assert.equal(filho.kill('SIGTERM'), true);
    assert.equal(filho.kill('SIGINT'), true);
    assert.equal(filho.kill('SIGKILL'), true);
    assert.equal(filho.kill('SIGHUP'), false);
    assert.equal(filho.kill(9), false);
    assert.deepEqual(c.sentinelas[0].enviadas, [
      { canal: cfg.lancamentoId, token: cfg.token, t: 'PARAR', sinal: 'SIGTERM' },
      { canal: cfg.lancamentoId, token: cfg.token, t: 'PARAR', sinal: 'SIGINT' },
      { canal: cfg.lancamentoId, token: cfg.token, t: 'ESCALAR' },
    ]);
    c.sentinelas[0].connected = false;
    assert.equal(filho.kill('SIGTERM'), false);
  });

  test('LS-11 — o kill é lido UMA vez e chamado com o receiver do filho (como o controle de processo faz): a função devolvida funciona desvinculada', () => {
    const c = cenario();
    const filho = c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    const kill = filho.kill;
    assert.equal(kill.call(filho, 'SIGTERM'), true);
    assert.equal(kill.call({}, 'SIGINT'), true);
  });

  test('LS-12 — mensagens da sentinela fora do formato esperado são ignoradas (sem exceção); o término e o grupo vêm do evento de saída e do diário, nunca da mensagem', async () => {
    const c = cenario();
    const filho = c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    for (const m of [null, 42, 'x', [], { t: 'FIM', grupoVazio: 'sim' }, { t: 'FIM', canal: 'outro', grupoVazio: true }]) filho.emit('message', m);
    await tiques();
    assert.equal(await c.supervisor.observarGrupo(7001), true);
    assert.deepEqual(c.sentinelas[0].enviadas, []);
  });
});

describe('LS — grupo, suspensão e encerramento coordenado', () => {
  const escritorDaSentinela = (c, id, eventos) => {
    const w = diarioModulo().abrirEscritor({ raiz: c.raiz, tentativaId: 't-0001', escritor: `sentinela-${id}` });
    for (const [tipo, dados] of eventos) w.registrar(tipo, { lancamentoId: id, ...dados });
    w.fechar();
  };
  const idDe = (c, i = 0) => JSON.parse(Buffer.from(c.chamadas[i][1][1], 'base64').toString('utf8')).lancamentoId;

  test('LS-20 — observarGrupo: sentinela viva = grupo povoado; saída com GRUPO_VERIFICADO vazio:true = vazio; vazio:false = povoado; sem registro, null ou pid desconhecido = LANÇA (nunca "vazio")', async () => {
    const c = cenario();
    const filho = c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    assert.equal(await c.supervisor.observarGrupo(filho.pid), true);
    filho.sair(0);
    await assert.rejects(c.supervisor.observarGrupo(filho.pid), (e) => e.code === 'GRUPO_NAO_CONFIRMADO');
    escritorDaSentinela(c, idDe(c), [['SENTINELA_ATIVA', { sentinelaPid: 7001 }], ['CLIENTE_LANCADO', { clientePid: 7002 }], ['CLIENTE_ENCERRADO', { codigo: 0, sinal: null }], ['GRUPO_VERIFICADO', { vazio: true }]]);
    assert.equal(await c.supervisor.observarGrupo(filho.pid), false);
    const d = cenario();
    const f2 = d.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    f2.sair(0);
    escritorDaSentinela(d, idDe(d), [['SENTINELA_ATIVA', { sentinelaPid: 7001 }], ['GRUPO_VERIFICADO', { vazio: false }]]);
    assert.equal(await d.supervisor.observarGrupo(f2.pid), true);
    const e2 = cenario();
    const f3 = e2.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    f3.sair(0);
    escritorDaSentinela(e2, idDe(e2), [['SENTINELA_ATIVA', { sentinelaPid: 7001 }], ['GRUPO_VERIFICADO', { vazio: null }]]);
    await assert.rejects(e2.supervisor.observarGrupo(f3.pid), (e) => e.code === 'GRUPO_NAO_CONFIRMADO');
    await assert.rejects(e2.supervisor.observarGrupo(99999), (e) => e.code === 'GRUPO_NAO_CONFIRMADO');
    await assert.rejects(e2.supervisor.observarGrupo(1), (e) => e.code === 'GRUPO_NAO_CONFIRMADO');
  });

  test('LS-21 — suspender() impede novos lançamentos (LANCAMENTO_SUSPENSO, sem intenção e sem spawn) e é irreversível', () => {
    const c = cenario();
    c.supervisor.suspender();
    assert.throws(() => c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES()), (e) => e.code === 'LANCAMENTO_SUSPENSO');
    assert.equal(c.ordem.length, 0);
    assert.equal(c.chamadas.length, 0);
  });

  test('LS-22 — (cenário 5) encerrarClientes: pede PARAR a cada sentinela viva, escala (ESCALAR) depois da cortesia, e só afirma ENCERRADOS com saída observada E grupo vazio no diário da sentinela', async () => {
    const c = cenario();
    const a = c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    const b = c.supervisor.spawn('/opt/postgres/bin/pg_restore', ['--list'], OPCOES());
    const idA = idDe(c, 0);
    const idB = idDe(c, 1);
    const p = c.supervisor.encerrarClientes({ cortesiaMs: 5000, esperaMs: 2000 });
    await tiques();
    assert.deepEqual(c.sentinelas[0].enviadas.map((m) => m.t), ['PARAR']);
    assert.deepEqual(c.sentinelas[1].enviadas.map((m) => m.t), ['PARAR']);
    escritorDaSentinela(c, idA, [['SENTINELA_ATIVA', { sentinelaPid: 7001 }], ['GRUPO_VERIFICADO', { vazio: true }]]);
    a.sair(null, 'SIGTERM');
    await c.tempo.avancar(5000);
    assert.deepEqual(c.sentinelas[1].enviadas.map((m) => m.t), ['PARAR', 'ESCALAR']);
    escritorDaSentinela(c, idB, [['SENTINELA_ATIVA', { sentinelaPid: 7002 }], ['GRUPO_VERIFICADO', { vazio: true }]]);
    b.sair(null, 'SIGKILL');
    const r = await p;
    assert.equal(r.resultado, 'ENCERRADOS');
    assert.deepEqual(r.clientes.map((x) => [x.encerrado, x.grupoVazio]), [[true, true], [true, true]]);
  });

  test('LS-23 — (cenário 14/21) sentinela que não sai, ou saiu sem grupo confirmado: NAO_COMPROVADO — nada é afirmado e a lista diz qual e por quê', async () => {
    const c = cenario();
    c.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    const p = c.supervisor.encerrarClientes({ cortesiaMs: 1000, esperaMs: 500 });
    await tiques();
    await c.tempo.avancar(1000);
    await c.tempo.avancar(500);
    const r = await p;
    assert.equal(r.resultado, 'NAO_COMPROVADO');
    assert.deepEqual(r.clientes.map((x) => x.encerrado), [false]);
    const d = cenario();
    const f = d.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    f.sair(0);
    const r2 = await d.supervisor.encerrarClientes({ cortesiaMs: 1000, esperaMs: 500 });
    assert.equal(r2.resultado, 'NAO_COMPROVADO');
    assert.deepEqual(r2.clientes.map((x) => [x.encerrado, x.grupoVazio]), [[true, null]]);
  });

  test('LS-24 — sem nenhum lançamento: NENHUM; idempotente: duas chamadas seguidas dão o mesmo resultado e não reenviam PARAR', async () => {
    const c = cenario();
    assert.equal((await c.supervisor.encerrarClientes({})).resultado, 'NENHUM');
    const d = cenario();
    const f = d.supervisor.spawn('/opt/postgres/bin/pg_dump', ARGS, OPCOES());
    f.sair(0);
    escritorDaSentinela(d, idDe(d), [['SENTINELA_ATIVA', { sentinelaPid: 7001 }], ['GRUPO_VERIFICADO', { vazio: true }]]);
    const r1 = await d.supervisor.encerrarClientes({});
    const r2 = await d.supervisor.encerrarClientes({});
    assert.deepEqual(r1, r2);
    assert.equal(d.sentinelas[0].enviadas.length, 0);
  });
});

describe('LS — genuinidade do spawn (a restauração real exige spawn genuíno)', () => {
  test('LS-30 — o spawn do supervisor com o child_process REAL interno é reconhecido como genuíno por ehSpawnReal; com spawnDoNode injetado, ou qualquer função alheia, NÃO é', () => {
    const base0 = { raiz: '/private/tmp/x', tentativaId: 't-0001', diario: { registrar() {} }, scriptDaSentinela: SCRIPT };
    const real = modulo().criarSupervisorDeProcessos({ ...base0, raiz: (() => { const r = path.join(base, 'real'); fs.mkdirSync(r, { mode: 0o700 }); return r; })() });
    assert.equal(portas().ehSpawnReal(real.spawn), true);
    assert.equal(portas().ehSpawnReal(require('node:child_process').spawn), true);
    const falso = modulo().criarSupervisorDeProcessos({ ...base0, raiz: base, spawnDoNode: () => new SentinelaFalsa() });
    assert.equal(portas().ehSpawnReal(falso.spawn), false);
    assert.equal(portas().ehSpawnReal(() => {}), false);
    assert.equal(portas().ehSpawnReal(real.observarGrupo), false);
  });
});
