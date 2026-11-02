'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): SENTINELA — o supervisor independente de UM cliente (pg_dump/pg_restore). Lógica pura com dependências injetadas: o filho, o canal de comunicação com o runner, o temporizador, a sonda do grupo e o diário durável são
 * falsos/controlados (diretório temporário privado criado aqui); nenhum processo real, nenhum sinal real, nenhum PostgreSQL. A prova com processos sintéticos reais está em `imagem-backup-supervisao-integrada.test.js`.
 *
 * Contrato (módulo `src/services/imagem-backup-sentinela.service`):
 *   criarSentinela({ config, spawn, diario, canal, temporizador, sondaGrupo, pidProprio }) -> { executar(): Promise<{ codigo, sinal, resultado }>, pedirParada(origem, sinal) }
 *   - registra SENTINELA_ATIVA, lança o cliente (spawn injetado) e SÓ ENTÃO registra CLIENTE_LANCADO; sinal enviado NUNCA vale como término: CLIENTE_ENCERRADO só nasce do evento de saída do filho;
 *   - o canal aceita só mensagens do canal e do token deste lançamento e só PARAR (SIGINT/SIGTERM) e ESCALAR (SIGKILL do CLIENTE); o resto é rejeitado e registrado, sem sinal algum;
 *   - perda do canal (runner morto) com o cliente vivo é ORFANDADE: a sentinela encerra o PRÓPRIO cliente (SIGTERM, cortesia, SIGKILL) e só declara encerramento com a saída observada;
 *   - depois da saída confere o grupo (sonda): vazio comprovado, ocupado ou não confirmado — o encerramento do processo principal não conclui a operação.
 */

const MODULO = 'src/services/imagem-backup-sentinela.service';
const modulo = () => exigirModulo(MODULO);
const diarioModulo = () => exigirModulo('src/services/imagem-backup-diario-execucao.service');
const LANCAMENTO = 'd'.repeat(32);
const TOKEN = 'e'.repeat(32);
const CONFIG = Object.freeze({ lancamentoId: LANCAMENTO, token: TOKEN, comando: '/opt/sintetico/pg_dump', argumentos: ['--format=custom'], cortesiaMs: 5000, esperaPosKillMs: 3000, grupo: { tentativas: 3, intervaloMs: 200 } });

let base;
before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-sentinela-'))); fs.chmodSync(base, 0o700); });
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
  return {
    prazo,
    intervalo: (ms) => prazo(ms).promessa,
    async avancar(ms) { agora += ms; for (const i of pend) if (i.ativo && i.vence <= agora) { i.ativo = false; i.res(); } await tiques(); },
    pendentes: () => pend.filter((i) => i.ativo).length,
  };
}

class FilhoFalso extends EventEmitter {
  constructor({ pid = 6101, aceitaSinal = true, ignora = new Set() } = {}) {
    super();
    this.pid = pid;
    this.sinais = [];
    this.aceitaSinal = aceitaSinal;
    this.ignora = ignora;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(sinal) {
    this.sinais.push(sinal);
    return this.aceitaSinal;
  }

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

function cenario({ filho = new FilhoFalso(), config = CONFIG, sonda = async () => false, spawn = null, diarioFalha = null, cliente = null } = {}) {
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
  const sentinela = modulo().criarSentinela({
    config,
    spawn: spawn ?? ((...args) => { chamadas.push(args); return filho; }),
    diario,
    canal,
    temporizador: tempo,
    sondaGrupo: sonda,
    pidProprio: 6100,
  });
  const eventos = () => diarioModulo().lerTentativa({ raiz, tentativaId: 't-0001' }).escritores[`sentinela-${LANCAMENTO}`].eventos;
  return { sentinela, filho, canal, tempo, chamadas, eventos, raiz };
}
const tipos = (eventos) => eventos.map((e) => e.k);

describe('SN — lançamento, saída normal e registro da identidade', () => {
  test('SN-01 — (cenário 1) o cliente é lançado pelo spawn injetado com detached:true, shell:false e herdando os fluxos; saída 0 com grupo vazio: os eventos nascem NA ORDEM e o resultado espelha a saída', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    assert.equal(c.chamadas.length, 1);
    const [comando, args, opcoes] = c.chamadas[0];
    assert.equal(comando, CONFIG.comando);
    assert.deepEqual(args, CONFIG.argumentos);
    assert.equal(opcoes.shell, false);
    assert.equal(opcoes.detached, true);
    assert.equal(opcoes.stdio, 'inherit');
    c.filho.sair(0);
    const r = await p;
    assert.deepEqual({ ...r }, { codigo: 0, sinal: null, resultado: 'CONCLUIDO' });
    assert.deepEqual(tipos(c.eventos()), ['SENTINELA_ATIVA', 'CLIENTE_LANCADO', 'CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO', 'SENTINELA_FIM']);
    assert.equal(c.eventos()[1].d.clientePid, 6101);
    assert.equal(c.eventos()[3].d.vazio, true);
  });

  test('SN-02 — (cenário 31) código de saída diferente de zero e término por sinal são PROPAGADOS (espelho exato) e o término continua confirmado', async () => {
    let c = cenario();
    let p = c.sentinela.executar();
    await tiques();
    c.filho.sair(3);
    let r = await p;
    assert.deepEqual({ codigo: r.codigo, sinal: r.sinal, resultado: r.resultado }, { codigo: 3, sinal: null, resultado: 'ENCERRADO_COM_FALHA' });
    assert.ok(tipos(c.eventos()).includes('CLIENTE_ENCERRADO'));
    c = cenario();
    p = c.sentinela.executar();
    await tiques();
    c.filho.sair(null, 'SIGSEGV');
    r = await p;
    assert.deepEqual({ codigo: r.codigo, sinal: r.sinal, resultado: r.resultado }, { codigo: null, sinal: 'SIGSEGV', resultado: 'ENCERRADO_COM_FALHA' });
    assert.equal(c.eventos().find((e) => e.k === 'CLIENTE_ENCERRADO').d.sinal, 'SIGSEGV');
  });

  test('SN-03 — falha de início comprovada: spawn que lança, ou erro assíncrono sem pid, registra LANCAMENTO_FALHOU, não registra CLIENTE_LANCADO e sai com 127', async () => {
    let c = cenario({ spawn: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    let r = await c.sentinela.executar();
    assert.equal(r.codigo, 127);
    assert.deepEqual(tipos(c.eventos()), ['SENTINELA_ATIVA', 'LANCAMENTO_FALHOU', 'SENTINELA_FIM']);
    const semPid = new FilhoFalso({ pid: null });
    c = cenario({ filho: semPid });
    const p = c.sentinela.executar();
    await tiques();
    semPid.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    r = await p;
    assert.equal(r.codigo, 127);
    assert.deepEqual(tipos(c.eventos()), ['SENTINELA_ATIVA', 'LANCAMENTO_FALHOU', 'SENTINELA_FIM']);
  });

  test('SN-04 — diário que não consegue registrar SENTINELA_ATIVA: NENHUM cliente é lançado; que não consegue registrar CLIENTE_LANCADO: o cliente já lançado é encerrado (SIGKILL pela referência que a sentinela tem) em vez de ficar sem identidade registrada', async () => {
    let c = cenario({ diarioFalha: (t) => t === 'SENTINELA_ATIVA' });
    let r = await c.sentinela.executar();
    assert.equal(c.chamadas.length, 0);
    assert.equal(r.resultado, 'DIARIO_FALHOU');
    assert.equal(r.codigo, 71);
    const filho = new FilhoFalso();
    c = cenario({ filho, diarioFalha: (t) => t === 'CLIENTE_LANCADO' });
    const p = c.sentinela.executar();
    await tiques();
    assert.deepEqual(filho.sinais, ['SIGKILL']);
    filho.sair(null, 'SIGKILL');
    r = await p;
    assert.equal(r.resultado, 'DIARIO_FALHOU');
    assert.equal(r.codigo, 71);
  });

  test('SN-05 — o encerramento só é registrado quando o evento de saída do filho chega: sinal aceito pelo kill NÃO produz CLIENTE_ENCERRADO', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGTERM' });
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGTERM']);
    assert.equal(tipos(c.eventos()).includes('CLIENTE_ENCERRADO'), false);
    c.filho.sair(null, 'SIGTERM');
    const r = await p;
    assert.equal(r.sinal, 'SIGTERM');
    assert.ok(tipos(c.eventos()).includes('CLIENTE_ENCERRADO'));
  });
});

describe('SN — canal restrito', () => {
  test('SN-10 — PARAR (SIGINT/SIGTERM) é repassado UMA vez ao cliente e registrado (PARADA_SOLICITADA + SINAL_ENVIADO); repetição não reenvia; ESCALAR é o único caminho do SIGKILL', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGINT' });
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGINT' });
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT']);
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'ESCALAR' });
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGINT', 'SIGKILL']);
    const t = tipos(c.eventos());
    assert.equal(t.filter((k) => k === 'PARADA_SOLICITADA').length, 2);
    assert.equal(t.filter((k) => k === 'SINAL_ENVIADO').length, 2);
    c.filho.sair(null, 'SIGKILL');
    await p;
  });

  test('SN-11 — (cenário 30) mensagem NÃO autorizada é recusada e registrada, sem sinal: canal/token errados, tipo desconhecido, chave extra, sinal fora de SIGINT/SIGTERM em PARAR, mensagem que não é objeto', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    const ruins = [
      { canal: 'f'.repeat(32), token: TOKEN, t: 'PARAR', sinal: 'SIGTERM' },
      { canal: LANCAMENTO, token: '0'.repeat(32), t: 'PARAR', sinal: 'SIGTERM' },
      { canal: LANCAMENTO, token: TOKEN, t: 'MATAR_TUDO' },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGTERM', alvo: 1 },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGKILL' },
      { canal: LANCAMENTO, token: TOKEN, t: 'PARAR' },
      'texto', null, 42, [],
    ];
    for (const m of ruins) c.canal.mensagem(m);
    await tiques();
    assert.deepEqual(c.filho.sinais, []);
    const rejeitadas = c.eventos().filter((e) => e.k === 'MENSAGEM_REJEITADA');
    assert.ok(rejeitadas.length >= 1 && rejeitadas.length <= 5, 'registro limitado');
    assert.ok(rejeitadas.every((e) => ['MENSAGEM_NAO_AUTORIZADA', 'MENSAGEM_MALFORMADA'].includes(e.d.motivo)));
    c.filho.sair(0);
    await p;
  });

  test('SN-12 — mensagem depois da saída do cliente não envia sinal algum (o filho já terminou: nenhum sinal a um PID que pode ter sido reutilizado)', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    await p;
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGTERM' });
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'ESCALAR' });
    await tiques();
    assert.deepEqual(c.filho.sinais, []);
  });

  test('SN-13 — a sentinela informa o runner pelo canal (CLIENTE com o pid e FIM com o estado do grupo) e tolera canal já desconectado', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    await p;
    const tiposMsg = c.canal.enviados.map((m) => m.t);
    assert.deepEqual(tiposMsg, ['ATIVA', 'CLIENTE', 'FIM']);
    assert.equal(c.canal.enviados[2].grupoVazio, true);
    assert.ok(c.canal.enviados.every((m) => m.canal === LANCAMENTO));
    const d = cenario();
    d.canal.ligado = false;
    const q = d.sentinela.executar();
    await tiques();
    d.filho.sair(0);
    assert.equal((await q).codigo, 0);
  });
});

describe('SN — runner morto (órfã) e encerramento que resiste', () => {
  test('SN-20 — (cenários 6/7/8) o runner morre com o cliente vivo: a sentinela detecta a órfã, envia SIGTERM ao PRÓPRIO cliente, e só depois da saída observada registra o encerramento — recuperação positiva sem depender do runner', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGTERM']);
    assert.ok(tipos(c.eventos()).includes('ORFANDADE_DETECTADA'));
    assert.equal(tipos(c.eventos()).includes('CLIENTE_ENCERRADO'), false);
    c.filho.sair(null, 'SIGTERM');
    const r = await p;
    assert.equal(r.resultado, 'ENCERRADO_COM_FALHA');
    const t = tipos(c.eventos());
    assert.deepEqual(t.slice(-3), ['CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO', 'SENTINELA_FIM']);
  });

  test('SN-21 — (cenário 3) o cliente ignora o SIGTERM: depois da cortesia vem o SIGKILL, e o encerramento só vale com a saída observada', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, ['SIGTERM']);
    await c.tempo.avancar(4999);
    assert.deepEqual(c.filho.sinais, ['SIGTERM']);
    await c.tempo.avancar(1);
    assert.deepEqual(c.filho.sinais, ['SIGTERM', 'SIGKILL']);
    c.filho.sair(null, 'SIGKILL');
    const r = await p;
    assert.equal(r.sinal, 'SIGKILL');
    assert.ok(tipos(c.eventos()).includes('CLIENTE_ENCERRADO'));
  });

  test('SN-22 — cliente que resiste até ao SIGKILL: ENCERRAMENTO_NAO_COMPROVADO — o registro NUNCA afirma o encerramento (nenhum CLIENTE_ENCERRADO), nenhum PID é presumido morto, e o fim registra a causa', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.canal.desconectar();
    await tiques();
    await c.tempo.avancar(5000);
    await c.tempo.avancar(3000);
    const r = await p;
    assert.equal(r.resultado, 'ENCERRAMENTO_NAO_COMPROVADO');
    assert.equal(r.codigo, 70);
    const t = tipos(c.eventos());
    assert.equal(t.includes('CLIENTE_ENCERRADO'), false);
    assert.equal(t.includes('GRUPO_VERIFICADO'), false);
    assert.equal(c.eventos().at(-1).k, 'SENTINELA_FIM');
    assert.equal(c.eventos().at(-1).d.resultado, 'ENCERRAMENTO_NAO_COMPROVADO');
    assert.deepEqual(c.filho.sinais, ['SIGTERM', 'SIGKILL']);
  });

  test('SN-23 — runner morto DEPOIS de o cliente ter terminado: nenhum sinal é enviado', async () => {
    const c = cenario();
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    const r = await p;
    c.canal.desconectar();
    await tiques();
    assert.deepEqual(c.filho.sinais, []);
    assert.equal(r.codigo, 0);
  });

  test('SN-24 — kill recusado (retorno false) ou que lança é registrado como SINAL_ENVIADO aceito:false; a sentinela segue aguardando a saída, sem inventar término', async () => {
    const filho = new FilhoFalso({ aceitaSinal: false });
    filho.kill = (s) => { filho.sinais.push(s); throw new Error('ESRCH'); };
    const c = cenario({ filho });
    const p = c.sentinela.executar();
    await tiques();
    c.canal.mensagem({ canal: LANCAMENTO, token: TOKEN, t: 'PARAR', sinal: 'SIGTERM' });
    await tiques();
    assert.equal(c.eventos().find((e) => e.k === 'SINAL_ENVIADO').d.aceito, false);
    assert.equal(tipos(c.eventos()).includes('CLIENTE_ENCERRADO'), false);
    filho.sair(0);
    await p;
  });
});

describe('SN — grupo e descendentes', () => {
  test('SN-30 — (cenários 17/28) descendente vivo depois da saída do cliente: GRUPO_VERIFICADO vazio:false, resultado DESCENDENTES_ATIVOS — o fim do processo principal não conclui a operação', async () => {
    const c = cenario({ sonda: async () => true });
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    await tiques();
    await c.tempo.avancar(200);
    await c.tempo.avancar(200);
    const r = await p;
    assert.equal(r.resultado, 'DESCENDENTES_ATIVOS');
    assert.equal(r.codigo, 0);
    assert.equal(c.eventos().find((e) => e.k === 'GRUPO_VERIFICADO').d.vazio, false);
  });

  test('SN-31 — sonda do grupo que lança ou responde algo estranho nunca vira "vazio": vazio:null (GRUPO_NAO_CONFIRMADO)', async () => {
    for (const sonda of [async () => { throw new Error('x'); }, async () => 'talvez', async () => undefined]) {
      const c = cenario({ sonda });
      const p = c.sentinela.executar();
      await tiques();
      c.filho.sair(0);
      await tiques();
      await c.tempo.avancar(200);
      await c.tempo.avancar(200);
      const r = await p;
      assert.equal(r.resultado, 'GRUPO_NAO_CONFIRMADO');
      assert.equal(c.eventos().find((e) => e.k === 'GRUPO_VERIFICADO').d.vazio, null);
    }
  });

  test('SN-32 — o grupo esvazia na segunda conferência: vazio:true e CONCLUIDO', async () => {
    const respostas = [true, false];
    const c = cenario({ sonda: async () => respostas.shift() });
    const p = c.sentinela.executar();
    await tiques();
    c.filho.sair(0);
    await tiques();
    await c.tempo.avancar(200);
    const r = await p;
    assert.equal(r.resultado, 'CONCLUIDO');
  });
});

describe('SN — configuração estrita', () => {
  test('SN-40 — configuração inválida (comando relativo, token ou id fora do formato, argumento não texto, prazo inválido, dependência ausente) é recusada antes de qualquer efeito', () => {
    const base0 = { config: CONFIG, spawn: () => new FilhoFalso(), diario: { registrar() {} }, canal: new CanalFalso(), temporizador: temporizadorManual(), sondaGrupo: async () => false, pidProprio: 6100 };
    const ruins = [
      { ...base0, config: { ...CONFIG, comando: 'pg_dump' } },
      { ...base0, config: { ...CONFIG, token: 'curto' } },
      { ...base0, config: { ...CONFIG, lancamentoId: 'x' } },
      { ...base0, config: { ...CONFIG, argumentos: [1] } },
      { ...base0, config: { ...CONFIG, cortesiaMs: 0 } },
      { ...base0, config: { ...CONFIG, extra: 1 } },
      { ...base0, spawn: null },
      { ...base0, diario: null },
      { ...base0, pidProprio: 1 },
    ];
    for (const r of ruins) assert.throws(() => modulo().criarSentinela(r), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});
