'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): SENTINELA DO POSTMASTER — a especialização mínima da sentinela para o PostgreSQL efêmero. Lógica pura com dependências injetadas (filho, canal, temporizador manual, sonda do grupo, diário real em diretório privado, identidade e clientes
 * simulados); NENHUM processo real, NENHUM sinal real, nenhum PostgreSQL. A prova com processos sintéticos reais está em `imagem-backup-postmaster-integrada.test.js`.
 *
 * Contrato (módulo `src/services/imagem-backup-postmaster-sentinela.service`):
 *   criarSentinelaPostmaster({ config, spawn, diario, canal, temporizador, sondaGrupo, pidProprio, capturarBase, identificar, clientesPendentes }) -> { executar(): Promise<{ codigo, sinal, resultado }>, pedirParada(origem) }
 *   - encerramento do postmaster: ESPERA os clientes (até um prazo), reconfirma a IDENTIDADE e envia SIGINT; sem saída em 30 s, SIGQUIT SÓ como emergência (identidade E isolamento comprovados, evento durável gravado ANTES), com mais 15 s de observação. NUNCA SIGKILL, NUNCA SIGTERM;
 *   - sinal aceito não prova encerramento: CLIENTE_ENCERRADO só nasce do evento de saída; processo que persiste = ENCERRAMENTO_NAO_COMPROVADO; uso do SIGQUIT = ENCERRADO_ANORMAL (nunca CONCLUIDO);
 *   - o canal aceita só PARAR com SIGINT (início do encerramento ordenado); ESCALAR e qualquer outro sinal são rejeitados.
 */

const MODULO = 'src/services/imagem-backup-postmaster-sentinela.service';
const modulo = () => exigirModulo(MODULO);
const diarioModulo = () => exigirModulo('src/services/imagem-backup-diario-execucao.service');
const LANCAMENTO = 'a'.repeat(32);
const TOKEN = 'b'.repeat(32);
const CONFIG = Object.freeze({
  lancamentoId: LANCAMENTO,
  token: TOKEN,
  comando: '/opt/sintetico/postgres',
  argumentos: ['-D', '/area/pgdata'],
  prazos: { sigintMs: 30000, sigquitMs: 15000, esperaClientesMs: 20000, passoClientesMs: 500 },
  grupo: { tentativas: 3, intervaloMs: 200 },
  identificacao: { tentativas: 3, intervaloMs: 100 },
});
const OK = Object.freeze({ comprovada: true, isolamento: true, falhas: [] });

let base;
before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-pmsent-'))); fs.chmodSync(base, 0o700); });
after(() => { fs.rmSync(base, { recursive: true, force: true }); });
let contador = 0;

const tick = () => new Promise((r) => setImmediate(r));
async function tiques(n = 8) { for (let i = 0; i < n; i += 1) await tick(); }

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
  return {
    prazo,
    intervalo: (ms) => prazo(ms).promessa,
    async avancar(ms) { agora += ms; for (const i of pend) if (i.ativo && i.vence <= agora) { i.ativo = false; i.res(); } await tiques(); },
    pendentes: () => pend.filter((i) => i.ativo).length,
  };
}

class FilhoFalso extends EventEmitter {
  constructor({ pid = 7101, aceita = () => true } = {}) {
    super();
    this.pid = pid;
    this.sinais = [];
    this.aceita = aceita;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(sinal) { this.sinais.push(sinal); return this.aceita(sinal); }
  sair(codigo, sinal = null) { this.exitCode = codigo; this.signalCode = sinal; this.emit('exit', codigo, sinal); }
}

class CanalFalso {
  constructor() { this.enviados = []; this.cbMensagem = null; this.cbDesconectar = null; this.ligado = true; }
  enviar(m) { this.enviados.push(m); return this.ligado; }
  aoMensagem(cb) { this.cbMensagem = cb; }
  aoDesconectar(cb) { this.cbDesconectar = cb; }
  conectado() { return this.ligado; }
  mensagem(m) { this.cbMensagem(m); }
  desconectar() { this.ligado = false; this.cbDesconectar(); }
}

function cenario({ filho = new FilhoFalso(), config = CONFIG, sonda = async () => false, spawn = null, diarioFalha = null, identificar = null, clientes = null, base: capturarBase = null } = {}) {
  contador += 1;
  const raiz = path.join(base, `estado-${contador}`);
  fs.mkdirSync(raiz, { mode: 0o700 });
  const d = diarioModulo();
  d.iniciarTentativa({ raiz, tentativaId: 't-0001', runnerPid: process.pid }).fechar();
  const real = d.abrirEscritor({ raiz, tentativaId: 't-0001', escritor: `sentinela-${LANCAMENTO}` });
  const diario = diarioFalha === null ? real : Object.freeze({ registrar(tipo, dados) { if (diarioFalha(tipo)) throw Object.assign(new Error('x'), { code: 'DIARIO_NAO_DURAVEL' }); return real.registrar(tipo, dados); } });
  const canal = new CanalFalso();
  const tempo = temporizadorManual();
  const chamadas = [];
  const consultas = { identificar: [], clientes: 0 };
  const sentinela = modulo().criarSentinelaPostmaster({
    config,
    spawn: spawn ?? ((...args) => { chamadas.push(args); return filho; }),
    diario,
    canal,
    temporizador: tempo,
    sondaGrupo: sonda,
    pidProprio: 7100,
    capturarBase: capturarBase ?? (async () => true),
    identificar: async (contexto) => { consultas.identificar.push(contexto); return identificar === null ? OK : identificar(consultas.identificar.length, contexto); },
    clientesPendentes: async () => { consultas.clientes += 1; return clientes === null ? 'NENHUM' : clientes(consultas.clientes); },
  });
  const eventos = () => diarioModulo().lerTentativa({ raiz, tentativaId: 't-0001' }).escritores[`sentinela-${LANCAMENTO}`].eventos;
  return { sentinela, filho, canal, tempo, chamadas, eventos, raiz, consultas };
}
const tipos = (eventos) => eventos.map((e) => e.k);
const PARAR = { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGINT' };

describe('[PMS] sentinela do postmaster — execução normal', () => {
  test('PMS-01 — o postmaster nasce com detached:true, shell:false e fluxos herdados; PARAR(SIGINT) encerra: SIGINT único, saída 0 e grupo vazio => CONCLUIDO, na ordem dos eventos', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    assert.equal(c.chamadas.length, 1);
    const [comando, args, opcoes] = c.chamadas[0];
    assert.equal(comando, CONFIG.comando);
    assert.deepEqual(args, CONFIG.argumentos);
    assert.deepEqual({ shell: opcoes.shell, detached: opcoes.detached, stdio: opcoes.stdio }, { shell: false, detached: true, stdio: 'inherit' });
    assert.deepEqual(c.canal.enviados.map((m) => m.t), ['ATIVA', 'CLIENTE']);
    assert.equal(c.canal.enviados[1].clientePid, 7101);
    c.canal.mensagem(PARAR);
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    await p;
    await assert.rejects(() => c.sentinela.executar(), (f) => f.code === 'CONFIGURACAO_INVALIDA');
    assert.deepEqual(tipos(c.eventos()), ['SENTINELA_ATIVA', 'CLIENTE_LANCADO', 'POSTMASTER_ORDEM', 'PARADA_SOLICITADA', 'SINAL_ENVIADO', 'CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO', 'SENTINELA_FIM']);
    assert.equal(c.eventos().at(-1).d.resultado, 'CONCLUIDO');
    assert.equal(c.eventos().find((e) => e.k === 'POSTMASTER_ORDEM').d.clientes, 'NENHUM');
  });

  test('PMS-02 — saída espontânea (sem pedido) com código 0 e grupo vazio: CONCLUIDO; nenhum sinal enviado', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    const r = await p;
    assert.deepEqual({ ...r }, { codigo: 0, sinal: null, resultado: 'CONCLUIDO' });
    assert.deepEqual(c.filho.sinais, []);
  });

  test('PMS-03 — saída por código diferente de zero sem SIGQUIT: ENCERRADO_ANORMAL (nunca CONCLUIDO) e o código é espelhado', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(1);
    const r = await p;
    assert.deepEqual({ ...r }, { codigo: 1, sinal: null, resultado: 'ENCERRADO_ANORMAL' });
  });

  test('PMS-04 — a identidade é capturada logo depois do spawn e antes do registro CLIENTE_LANCADO; a falta da base NÃO impede o registro mas é lembrada (a identificação seguinte decide)', async () => {
    const c = cenario({ base: async () => false });
    const p = c.sentinela.executar();
    await tiques();
    assert.ok(tipos(c.eventos()).includes('CLIENTE_LANCADO'));
    c.canal.mensagem(PARAR);
    await tiques();
    assert.equal(c.consultas.identificar[0].baseCapturada, false);
    c.filho.sair(0);
    await p;
  });
});

describe('[PMS] sentinela do postmaster — SIGINT, SIGQUIT de emergência e processo resistente', () => {
  test('PMS-05 — SIGINT esgotado (30 s sem saída): a identidade e o isolamento são reconfirmados, o evento de emergência é gravado ANTES do SIGQUIT, que sai uma vez; a saída posterior é ENCERRADO_ANORMAL', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    await c.tempo.avancar(29999);
    assert.deepEqual(c.filho.sinais, ['SIGINT'], 'antes dos 30 s nada mais é enviado');
    await c.tempo.avancar(1);
    assert.deepEqual(c.filho.sinais, ['SIGINT', 'SIGQUIT']);
    assert.ok(c.consultas.identificar.length >= 2, 'a identidade é reconferida antes de CADA sinal');
    const t = tipos(c.eventos());
    assert.ok(t.indexOf('POSTMASTER_EMERGENCIA') < t.lastIndexOf('SINAL_ENVIADO'), 'a emergência é registrada antes do SIGQUIT');
    c.filho.sair(2);
    const r = await p;
    assert.equal(r.resultado, 'ENCERRADO_ANORMAL');
    assert.ok(!c.filho.sinais.includes('SIGKILL') && !c.filho.sinais.includes('SIGTERM'));
  });

  test('PMS-05b — o SIGQUIT foi usado e o postmaster sai com código 0 e sem sinal (parece limpo): ainda assim é ENCERRADO_ANORMAL, nunca CONCLUIDO', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(30000);
    assert.deepEqual(c.filho.sinais, ['SIGINT', 'SIGQUIT']);
    c.filho.sair(0);
    const r = await p;
    assert.deepEqual({ codigo: r.codigo, sinal: r.sinal, resultado: r.resultado }, { codigo: 0, sinal: null, resultado: 'ENCERRADO_ANORMAL' });
  });

  test('PMS-06 — processo resistente (ignora SIGINT e SIGQUIT): depois de 30 s + 15 s o resultado é ENCERRAMENTO_NAO_COMPROVADO (70), com exatamente [SIGINT, SIGQUIT], sem SIGKILL e sem CLIENTE_ENCERRADO', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(30000);
    await c.tempo.avancar(14999);
    assert.deepEqual(c.filho.sinais, ['SIGINT', 'SIGQUIT']);
    await c.tempo.avancar(1);
    const r = await p;
    assert.deepEqual({ ...r }, { codigo: 70, sinal: null, resultado: 'ENCERRAMENTO_NAO_COMPROVADO' });
    assert.deepEqual(c.filho.sinais, ['SIGINT', 'SIGQUIT']);
    assert.ok(!tipos(c.eventos()).includes('CLIENTE_ENCERRADO'), 'sinal aceito não prova encerramento');
  });

  test('PMS-07 — falha de sinalização: o SIGINT recusado pelo sistema NÃO escala para SIGQUIT (não houve SIGINT esgotado); só observa 15 s e declara FALHA_DE_SINALIZACAO', async () => {
    const c = cenario({ filho: new FilhoFalso({ aceita: () => false }) });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    assert.equal(c.eventos().find((e) => e.k === 'SINAL_ENVIADO').d.aceito, false);
    await c.tempo.avancar(30000);
    assert.deepEqual(c.filho.sinais, ['SIGINT'], 'sem SIGQUIT depois de uma falha de entrega');
    await c.tempo.avancar(15000);
    const r = await p;
    assert.equal(r.resultado, 'FALHA_DE_SINALIZACAO');
    assert.equal(r.codigo, 70);
  });

  test('PMS-08 — o sinal lançar exceção vale como falha de sinalização (mesmo resultado), nunca como sucesso', async () => {
    const f = new FilhoFalso();
    f.kill = () => { throw new Error('x'); };
    const c = cenario({ filho: f });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(15000);
    assert.equal((await p).resultado, 'FALHA_DE_SINALIZACAO');
  });

  test('PMS-09 — isolamento NÃO comprovado no momento da emergência: SIGQUIT não é enviado (IDENTIDADE_INCERTA); a identidade do filho pode seguir comprovada', async () => {
    const c = cenario({ identificar: (n) => (n === 1 ? OK : { comprovada: true, isolamento: false, falhas: ['ISOLAMENTO_PORTA_DIVERGENTE'] }) });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(30000);
    const r = await p;
    assert.equal(r.resultado, 'IDENTIDADE_INCERTA');
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    const e = c.eventos().find((x) => x.k === 'IDENTIDADE_NAO_COMPROVADA');
    assert.deepEqual({ fase: e.d.fase, motivo: e.d.motivo }, { fase: 'SIGQUIT', motivo: 'ISOLAMENTO_PORTA_DIVERGENTE' });
  });

  test('PMS-10 — identidade perdida entre o SIGINT e a emergência (outro processo, pid reutilizado): nenhum SIGQUIT', async () => {
    const c = cenario({ identificar: (n) => (n === 1 ? OK : { comprovada: false, isolamento: false, falhas: ['INICIO_DIVERGENTE'] }) });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(30000);
    await c.tempo.avancar(100);
    await c.tempo.avancar(100);
    const r = await p;
    assert.equal(r.resultado, 'IDENTIDADE_INCERTA');
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
  });

  test('PMS-11 — o registro da emergência NÃO é durável: o SIGQUIT não sai (ENCERRAMENTO_NAO_COMPROVADO); o postmaster segue preservado', async () => {
    const c = cenario({ diarioFalha: (tipo) => tipo === 'POSTMASTER_EMERGENCIA' });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(30000);
    const r = await p;
    assert.equal(r.resultado, 'ENCERRAMENTO_NAO_COMPROVADO');
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
  });

  test('PMS-12 — a lógica nunca contém SIGKILL, SIGTERM, process.kill nem sinal por grupo (fonte)', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '../../src/services/imagem-backup-postmaster-sentinela.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/SIGKILL|SIGTERM|process\.kill|kill\(-|child_process/.test(fonte), false);
    assert.deepEqual(fonte.match(/SIG[A-Z]+/g).filter((s, i, a) => a.indexOf(s) === i).sort(), ['SIGINT', 'SIGQUIT']);
  });
});

describe('[PMS] sentinela do postmaster — identidade', () => {
  test('PMS-13 — identidade divergente antes do SIGINT: tentativas limitadas e NENHUM sinal; IDENTIDADE_INCERTA (70), com o motivo registrado', async () => {
    const c = cenario({ identificar: () => ({ comprovada: false, isolamento: false, falhas: ['POSTMASTER_PID_DIVERGENTE'] }) });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(100);
    await c.tempo.avancar(100);
    const r = await p;
    assert.deepEqual({ ...r }, { codigo: 70, sinal: null, resultado: 'IDENTIDADE_INCERTA' });
    assert.deepEqual(c.filho.sinais, []);
    assert.equal(c.consultas.identificar.length, 3);
    const e = c.eventos().find((x) => x.k === 'IDENTIDADE_NAO_COMPROVADA');
    assert.deepEqual({ fase: e.d.fase, motivo: e.d.motivo }, { fase: 'SIGINT', motivo: 'POSTMASTER_PID_DIVERGENTE' });
  });

  test('PMS-14 — a consulta de identidade que LANÇA vale como não comprovada (nunca como sinal)', async () => {
    const c = cenario({ identificar: () => { throw new Error('ps indisponivel'); } });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(100);
    await c.tempo.avancar(100);
    assert.equal((await p).resultado, 'IDENTIDADE_INCERTA');
    assert.deepEqual(c.filho.sinais, []);
  });

  test('PMS-15 — a identidade que se comprova na segunda tentativa (postmaster.pid ainda não escrito) permite o SIGINT', async () => {
    const c = cenario({ identificar: (n) => (n < 2 ? { comprovada: false, isolamento: false, falhas: ['POSTMASTER_PID_AUSENTE'] } : OK) });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    await c.tempo.avancar(100);
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    assert.equal((await p).resultado, 'CONCLUIDO');
  });

  test('PMS-16 — o contexto da identificação traz o pid do postmaster e o estado do handle (saída do filho é conferida)', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    await tiques();
    assert.deepEqual({ ...c.consultas.identificar[0].filho }, { pid: 7101, exitCode: null, signalCode: null });
    assert.equal(c.consultas.identificar[0].fase, 'SIGINT');
    c.filho.sair(0);
    await p;
  });
});

describe('[PMS] sentinela do postmaster — ordem: clientes antes do postmaster, órfã e canal', () => {
  test('PMS-17 — runner morto (canal perdido) com cliente ainda ativo: ORFANDADE_DETECTADA, o postmaster ESPERA os clientes e só então recebe o SIGINT', async () => {
    let pendente = true;
    const c = cenario({ clientes: () => (pendente ? 'PENDENTES' : 'NENHUM') });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, [], 'cliente pendente: nada ainda para o postmaster');
    await c.tempo.avancar(500);
    assert.deepEqual(c.filho.sinais, []);
    pendente = false;
    await c.tempo.avancar(500);
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    await p;
    const t = tipos(c.eventos());
    assert.ok(t.indexOf('ORFANDADE_DETECTADA') < t.indexOf('POSTMASTER_ORDEM') && t.indexOf('POSTMASTER_ORDEM') < t.indexOf('SINAL_ENVIADO'));
    assert.equal(c.eventos().find((e) => e.k === 'POSTMASTER_ORDEM').d.clientes, 'NENHUM');
  });

  test('PMS-18 — cliente que nunca se confirma: depois de esperaClientesMs o SIGINT sai mesmo assim, e a ordem registra PENDENTES (a tentativa não vira CONCLUIDA por isso)', async () => {
    const c = cenario({ clientes: () => 'PENDENTES' });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.desconectar();
    await tiques();
    await c.tempo.avancar(20000);
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    assert.equal(c.eventos().find((e) => e.k === 'POSTMASTER_ORDEM').d.clientes, 'PENDENTES');
    c.filho.sair(0);
    await p;
  });

  test('PMS-19 — consulta de clientes que falha ou lança: INCONCLUSIVO (também espera o prazo); nunca é tratada como "sem clientes"', async () => {
    const c = cenario({ clientes: () => { throw new Error('x'); } });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, []);
    await c.tempo.avancar(20000);
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    assert.equal(c.eventos().find((e) => e.k === 'POSTMASTER_ORDEM').d.clientes, 'INCONCLUSIVO');
    c.filho.sair(0);
    await p;
  });

  test('PMS-20 — runner morto ANTES da confirmação de prontidão (canal perdido logo depois do lançamento): o encerramento ordenado acontece sem o runner', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques(2);
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    const r = await p;
    assert.equal(r.resultado, 'CONCLUIDO');
  });

  test('PMS-21 — canal já perdido no instante do lançamento: o encerramento ordenado começa sozinho', async () => {
    const c = cenario();
    c.canal.ligado = false;
    const p = c.sentinela.executar();
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    await p;
  });

  test('PMS-22 — mensagens: só PARAR com SIGINT é aceita; ESCALAR, SIGTERM, SIGKILL, SIGQUIT, token errado, canal errado e formato estranho são rejeitados SEM sinal', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    for (const m of [
      { canal: LANCAMENTO, token: TOKEN, t: 'ESCALAR' },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGTERM' },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGKILL' },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGQUIT' },
      { canal: LANCAMENTO, token: 'c'.repeat(32), t: 'PARAR', sinal: 'SIGINT' },
      { canal: 'f'.repeat(32), token: TOKEN, t: 'PARAR', sinal: 'SIGINT' },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGINT', extra: 1 },
      null, 'texto', 7,
    ]) c.canal.mensagem(m);
    await tiques();
    assert.deepEqual(c.filho.sinais, []);
    assert.ok(tipos(c.eventos()).includes('MENSAGEM_REJEITADA'));
    c.filho.sair(0);
    await p;
  });

  test('PMS-23 — pedido repetido de parada: um único encerramento ordenado, um único SIGINT', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem(PARAR);
    c.canal.mensagem(PARAR);
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    await p;
  });

  test('PMS-24 — pedirParada (sinal ao próprio worker) inicia o mesmo encerramento ordenado; sinal que não é SIGINT/SIGTERM/SIGHUP do worker não existe aqui', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.sentinela.pedirParada('SINAL_AO_SENTINELA');
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    await p;
  });
});

describe('[PMS] sentinela do postmaster — diário e lançamento', () => {
  test('PMS-25 — sem SENTINELA_ATIVA durável nada é lançado', async () => {
    const c = cenario({ diarioFalha: (tipo) => tipo === 'SENTINELA_ATIVA' });
    const r = await c.sentinela.executar();
    assert.equal(r.resultado, 'DIARIO_FALHOU');
    assert.equal(r.codigo, 71);
    assert.equal(c.chamadas.length, 0);
  });

  test('PMS-26 — CLIENTE_LANCADO não durável (registro incompleto entre o lançamento e a identidade): o postmaster é encerrado POR SIGINT (nunca SIGKILL) e o resultado é DIARIO_FALHOU', async () => {
    const c = cenario({ diarioFalha: (tipo) => tipo === 'CLIENTE_LANCADO' });
    const p = c.sentinela.executar();
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.filho.sair(0);
    const r = await p;
    assert.deepEqual({ codigo: r.codigo, resultado: r.resultado }, { codigo: 71, resultado: 'DIARIO_FALHOU' });
    assert.ok(!c.filho.sinais.includes('SIGKILL'));
  });

  test('PMS-27 — spawn que lança, ou erro sem pid: LANCAMENTO_FALHOU (127), nada de CLIENTE_LANCADO', async () => {
    let c = cenario({ spawn: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    let r = await c.sentinela.executar();
    assert.equal(r.codigo, 127);
    assert.ok(!tipos(c.eventos()).includes('CLIENTE_LANCADO'));
    const semPid = new FilhoFalso({ pid: null });
    c = cenario({ filho: semPid });
    const p = c.sentinela.executar();
    await tiques();
    semPid.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    r = await p;
    assert.equal(r.codigo, 127);
  });

  test('PMS-28 — depois da saída o grupo é conferido: vazio => resultado normal; ocupado => DESCENDENTES_ATIVOS; não confirmado => GRUPO_NAO_CONFIRMADO; a sentinela NUNCA sinaliza o grupo', async () => {
    for (const [sonda, esperado] of [[async () => false, 'CONCLUIDO'], [async () => true, 'DESCENDENTES_ATIVOS'], [async () => { throw new Error('x'); }, 'GRUPO_NAO_CONFIRMADO']]) {
      const c = cenario({ sonda });
      const p = c.sentinela.executar();
      await tiques();
      c.canal.mensagem(PARAR);
      await tiques();
      c.filho.sair(0);
      await tiques();
      await c.tempo.avancar(200);
      await c.tempo.avancar(200);
      assert.equal((await p).resultado, esperado);
      assert.deepEqual(c.filho.sinais, ['SIGINT']);
    }
  });

  test('PMS-29 — registro de saída ou de grupo que falha: DIARIO_FALHOU (a saída ainda foi observada)', async () => {
    const c = cenario({ diarioFalha: (tipo) => tipo === 'GRUPO_VERIFICADO' });
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    assert.equal((await p).resultado, 'DIARIO_FALHOU');
  });

  test('PMS-30 — a configuração é estrita (chaves exatas, prazos positivos, caminho absoluto) e as dependências são obrigatórias', () => {
    const base0 = { config: CONFIG, spawn() {}, diario: { registrar() {} }, canal: new CanalFalso(), temporizador: temporizadorManual(), sondaGrupo: async () => false, pidProprio: 7100, capturarBase: async () => true, identificar: async () => OK, clientesPendentes: async () => 'NENHUM' };
    assert.doesNotThrow(() => modulo().criarSentinelaPostmaster(base0));
    for (const ruim of [
      { ...base0, config: { ...CONFIG, extra: 1 } },
      { ...base0, config: { ...CONFIG, comando: 'postgres' } },
      { ...base0, config: { ...CONFIG, prazos: { ...CONFIG.prazos, sigintMs: 0 } } },
      { ...base0, config: { ...CONFIG, prazos: { sigintMs: 1, sigquitMs: 1 } } },
      { ...base0, identificar: undefined },
      { ...base0, clientesPendentes: undefined },
      { ...base0, capturarBase: undefined },
      { ...base0, pidProprio: 1 },
      null,
    ]) assert.throws(() => modulo().criarSentinelaPostmaster(ruim), (f) => f.code === 'CONFIGURACAO_INVALIDA' || f instanceof TypeError);
  });
});
