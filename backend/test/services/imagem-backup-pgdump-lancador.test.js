'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-LANCADOR-SEGURO-1): LANÇADOR CONFIÁVEL do processo externo (futuro `pg_dump`). Só unitário e
 * em memória: o `spawn`, o processo filho, os eventos, os descritores e o sistema de grupos são falsos; nenhum processo, sinal, `kill`, PostgreSQL ou
 * relógio reais. Sincronização por promessas controladas e por um único `setImmediate` de descarga (sem esperas arbitrárias); cada teste tem prazo próprio.
 *
 * CONTRATO REAL CONFIRMADO (lido no código):
 *   - o serviço do dump chama `lancador.lancar(spec)` com spec = { executavel, argumentos, ambiente, opcoes: { shell: false, detached: true,
 *     stdio: ['ignore', descritor, 'ignore'] } } e exige o retorno `{ pid > 1, saida, fluxosFechados }` (promessas); rejeição ou retorno inválido viram falha
 *     de `iniciar()` e o descritor do PAI é fechado; nada é sinalizado;
 *   - o supervisor trata QUALQUER falha de `iniciar()` (ou retorno sem pgid/promessas) como `{ saida: 1, liberarTravaPermitido: false, motivos:
 *     ['INICIO_FALHOU'] }`, descartando o erro: ele NÃO distingue "comprovadamente não iniciado" de "possivelmente iniciado" (e aceita pgid 1, que o serviço
 *     do dump já recusa). Em ambos os casos a trava fica retida (D1).
 *
 * CONFLITO CONTRATUAL / BLOQUEIO ARQUITETURAL (documentado, não resolvido aqui): como o supervisor e a composição não têm onde carregar a diferença, o único
 * canal de diagnóstico seguro da distinção é o PRÓPRIO LANÇADOR (`situacao()` e o `code` da rejeição). Levar essa distinção ao resultado público exigiria
 * mudar o supervisor ou a composição, e isso depende de decisão de Ramires/ChatGPT. Os testes LAN-07 caracterizam o comportamento atual e NÃO impõem mudança.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado nesta fase):
 *   src/services/imagem-backup-pgdump-lancador.service.js exporta `criarLancadorComSpawn({ spawn })` -> { lancar(spec), situacao() }.
 *   `criarLancadorComSpawn` aceita o `spawn` injetado SÓ para estes testes (D8): a execução real escolherá `child_process` INTERNAMENTE, sem receber nada do
 *   chamador (TODO LAN-11a). Compatível com o contrato atual: `lancar(spec)` -> Promise<{ pid, saida, fluxosFechados }>.
 *   `lancar(spec)`:
 *     1. captura e valida o spec ANTES de qualquer spawn (SPEC_INVALIDO, sem efeito): executável absoluto terminado em /pg_dump; exatamente os quatro
 *        argumentos fechados (`--format=custom`, `--no-password`, `--snapshot=<id>`, `--dbname=<nome>`); ambiente exatamente PGPASSFILE, PGHOST, PGPORT,
 *        PGUSER (texto); opcoes exatamente { shell: false, detached: true, stdio: ['ignore', inteiro >= 3, 'ignore'] };
 *     2. chama `spawn(executavel, argumentos, { env: <cópia de ambiente>, shell: false, detached: true, stdio })` (e mais nada), UMA vez, e registra os
 *        ouvintes do filho de forma SÍNCRONA (os eventos reais chegam no turno seguinte);
 *     3. só RESOLVE depois do evento `spawn` e com `pid` inteiro > 1 lido UMA vez: `{ pid, saida, fluxosFechados }`, nada mais;
 *        `saida` resolve só com o evento `exit` e um par {código inteiro, sinal nulo} ou {código nulo, sinal texto}; `fluxosFechados` resolve só com
 *        `close`; um não prova o outro; eventos duplicados valem uma vez; `error` DEPOIS do início não resolve nem rejeita nada;
 *     4. REJEITA com `code` fixo: NAO_INICIADO (spawn lançou, ou `error` antes de `spawn` sem pid: falha COMPROVADA), INICIO_INCONCLUSIVO (`spawn` com pid
 *        inválido, ou `error` antes de `spawn` COM pid: o processo pode existir), SPEC_INVALIDO; nunca inventa pid, saída ou encerramento; nunca sinaliza
 *        o filho nem qualquer pid; mantém o filho observado (sem `kill`);
 *     5. `situacao()` devolve, congelada, a lista de lançamentos { estado: NAO_INICIADO | INICIADO | INCONCLUSIVO, pid | null, terminou, fluxosFechados,
 *        causa (código seguro lido uma vez | null), grupoComprovado: false }: o lançador NÃO afirma identidade de grupo (reutilização de PGID é pendência).
 *
 * COMO LER ESTES TESTES NESTA FASE: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-pgdump-lancador.service';
const modulo = () => exigirModulo(MODULO);
const criar = (spawn) => modulo().criarLancadorComSpawn({ spawn });
const PRAZO_DO_TESTE = 10000;
const PID = 4242;
const DESCRITOR = 77;
const ID_SNAPSHOT = '0000000A-0000002B-7';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const HOST = 'db.interno.exemplo';
const USUARIO = 'usuario_secreto';
const SENHA_ARQUIVO = '/etc/safework/pgpass';
const MARCADORES = [SEGREDO, HOST, USUARIO, 'postgres://', 'password'];
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const CODIGOS = new Set(['NAO_INICIADO', 'INICIO_INCONCLUSIVO', 'SPEC_INVALIDO', 'TERMINO_INVALIDO']);

const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);
const descarga = () => new Promise((resolver) => setImmediate(resolver));

/** Resultado de uma promessa SEM pendurar o teste: o que ainda não se resolveu depois de uma descarga é "pendente". */
async function desfecho(promessa) {
  return Promise.race([
    promessa.then((valor) => ({ tipo: 'resolvido', valor }), (erro) => ({ tipo: 'rejeitado', erro })),
    descarga().then(() => ({ tipo: 'pendente' })),
  ]);
}

function erroSensivel(codigo = 'EACCES') {
  return Object.assign(new Error(`spawn ${SENHA_ARQUIVO} falhou: password=${SEGREDO} host=${HOST} user=${USUARIO} postgres://u:${SEGREDO}@${HOST}/db`), {
    code: codigo, detail: `detalhe ${SEGREDO}`, path: SENHA_ARQUIVO,
  });
}

function semMarcadores(valor, rotulo) {
  const texto = typeof valor === 'string' ? valor : (JSON.stringify(valor) ?? String(valor));
  for (const marcador of MARCADORES) assert.equal(texto.includes(marcador), false, `${rotulo}: não pode conter "${marcador}"`);
}

const textoPublico = (erro) => `${erro.message} ${String(erro)} ${JSON.stringify(erro)} ${String(erro.code)}`;
const comGetter = (objeto, chave, get) => Object.defineProperty(objeto, chave, { enumerable: true, configurable: true, get });

async function comConsoleEspiado(fn) {
  const util = require('node:util');
  const metodos = ['log', 'error', 'warn', 'info', 'debug', 'trace'];
  const originais = {};
  const chamadas = [];
  for (const nome of metodos) {
    originais[nome] = console[nome];
    console[nome] = (...argumentos) => { chamadas.push(`${nome}: ${argumentos.map((a) => util.inspect(a, { depth: 4 })).join(' ')}`); };
  }
  try {
    return { resultado: await fn(), chamadas };
  } finally {
    for (const nome of metodos) console[nome] = originais[nome];
  }
}

/** Processo filho falso: emissor mínimo (`on`, `once`, `off`) com `emitir`, `pid` configurável (valor ou função das leituras) e um `kill` que conta. */
function criarFilho(opcoes = {}) {
  // `pid` ausente = pid padrão da fixture; `pid: undefined` explícito é PRESERVADO (um valor padrão de parâmetro o substituiria); qualquer outro valor é preservado.
  const pid = Object.hasOwn(opcoes, 'pid') ? opcoes.pid : PID;
  const ouvintes = {};
  const filho = {
    killChamadas: 0,
    leiturasDoPid: 0,
    on(evento, f) { (ouvintes[evento] ??= []).push({ f, uma: false }); return filho; },
    once(evento, f) { (ouvintes[evento] ??= []).push({ f, uma: true }); return filho; },
    off(evento, f) { ouvintes[evento] = (ouvintes[evento] ?? []).filter((o) => o.f !== f); return filho; },
    removeListener(evento, f) { return filho.off(evento, f); },
    kill() { filho.killChamadas += 1; return true; },
    ouvintes: (evento) => (ouvintes[evento] ?? []).length,
    emitir(evento, ...argumentos) {
      const lista = [...(ouvintes[evento] ?? [])];
      for (const o of lista) { if (o.uma) filho.off(evento, o.f); o.f(...argumentos); }
      return lista.length;
    },
  };
  Object.defineProperty(filho, 'pid', {
    enumerable: true,
    get() { filho.leiturasDoPid += 1; return typeof pid === 'function' ? pid(filho.leiturasDoPid) : pid; },
  });
  return filho;
}

/** `spawn` falso: registra a chamada, devolve o filho (ou lança) e, opcionalmente, agenda eventos para DEPOIS de os ouvintes serem registrados. */
function criarSpawn({ filho = criarFilho(), lanca = null, aoLancar = null } = {}) {
  const chamadas = [];
  const spawn = (executavel, argumentos, opcoes) => {
    chamadas.push({ executavel, argumentos, opcoes });
    if (lanca) throw lanca;
    if (aoLancar) queueMicrotask(() => aoLancar(filho));
    return filho;
  };
  return { spawn, chamadas, filho };
}

const SPEC = () => ({
  executavel: '/usr/lib/postgresql/16/bin/pg_dump',
  argumentos: ['--format=custom', '--no-password', `--snapshot=${ID_SNAPSHOT}`, '--dbname=gestao_epi'],
  ambiente: { PGPASSFILE: SENHA_ARQUIVO, PGHOST: HOST, PGPORT: '5432', PGUSER: USUARIO },
  opcoes: { shell: false, detached: true, stdio: ['ignore', DESCRITOR, 'ignore'] },
});

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: o supervisor atual e o filho falso', () => {
  teste('CTL-01 — o supervisor REAL trata qualquer falha de `iniciar()` com a MESMA decisão de segurança (saída 1, trava não liberável, nenhuma consulta de grupo nem sinal); o motivo INICIO_FALHOU é mantido e o código reconhecido acrescenta apenas um motivo INFORMATIVO (NAO_INICIADO ou INICIO_INCONCLUSIVO)', async () => {
    const { supervisionar } = exigirModulo('src/services/imagem-backup-supervisor.service');
    for (const falha of [Object.assign(new Error('a'), { code: 'NAO_INICIADO' }), Object.assign(new Error('b'), { code: 'INICIO_INCONCLUSIVO' })]) {
      const contagem = { grupo: 0, sinal: 0 };
      const r = await supervisionar({
        async iniciar() { throw falha; },
        grupo: { async vivos() { contagem.grupo += 1; return false; } },
        sinais: { async enviar() { contagem.sinal += 1; return true; } },
        temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
        prazos: { ...PRAZOS },
      });
      assert.equal(r.saida, 1);
      assert.equal(r.liberarTravaPermitido, false);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU', falha.code]);
      assert.deepEqual(contagem, { grupo: 0, sinal: 0 });
    }
  });

  teste('CTL-02 — o filho falso entrega eventos na ordem pedida e a descarga distingue promessa resolvida de pendente', async () => {
    const filho = criarFilho();
    let visto = 0;
    filho.on('exit', () => { visto += 1; });
    filho.emitir('exit', 0, null);
    assert.equal(visto, 1);
    assert.equal((await desfecho(Promise.resolve(1))).tipo, 'resolvido');
    assert.equal((await desfecho(new Promise(() => {}))).tipo, 'pendente');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-01
describe('[LAN-01] processo NÃO iniciado: falha comprovada, sem pid, saída nem encerramento inventados', () => {
  teste('LAN-01 — `spawn` lança de forma síncrona: rejeita com NAO_INICIADO; nada resolvido; o filho nunca é sinalizado; a causa segura fica no diagnóstico', async () => {
    const s = criarSpawn({ lanca: erroSensivel('EINVAL') });
    const lancador = criar(s.spawn);
    const d = await desfecho(lancador.lancar(SPEC()));
    assert.equal(d.tipo, 'rejeitado');
    assert.equal(d.erro.code, 'NAO_INICIADO');
    for (const campo of ['pid', 'saida', 'fluxosFechados']) assert.equal(Object.hasOwn(d.erro, campo), false, campo);
    assert.equal(s.chamadas.length, 1);
    const [registro] = lancador.situacao();
    assert.equal(registro.estado, 'NAO_INICIADO');
    assert.equal(registro.pid, null);
    assert.equal(registro.causa, 'EINVAL');
  });

  teste('LAN-01b — evento `error` ANTES de `spawn` e SEM pid (ENOENT/EACCES): falha comprovada, NAO_INICIADO; o filho nunca é sinalizado', async () => {
    const filho = criarFilho({ pid: undefined });
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('error', erroSensivel('ENOENT'));
    const d = await desfecho(p);
    assert.equal(d.tipo, 'rejeitado');
    assert.equal(d.erro.code, 'NAO_INICIADO');
    assert.equal(filho.killChamadas, 0);
    assert.equal(lancador.situacao()[0].estado, 'NAO_INICIADO');
    assert.equal(lancador.situacao()[0].causa, 'ENOENT');
  });

  teste('LAN-01c — `error` ANTES de `spawn` mas COM pid presente: NÃO é falha comprovada; INICIO_INCONCLUSIVO, sem sinal e sem resolver nada', async () => {
    const filho = criarFilho({ pid: PID });
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('error', erroSensivel('EPERM'));
    const d = await desfecho(p);
    assert.equal(d.tipo, 'rejeitado');
    assert.equal(d.erro.code, 'INICIO_INCONCLUSIVO');
    assert.equal(filho.killChamadas, 0);
    assert.equal(lancador.situacao()[0].estado, 'INCONCLUSIVO');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-02
describe('[LAN-02] lançamento confirmado: o processo é vinculado às promessas de término e de fechamento dos fluxos', () => {
  teste('LAN-02 — `spawn` com pid válido: resolve só `{ pid, saida, fluxosFechados }`; as duas promessas nascem PENDENTES; `spawn` do sistema chamado uma vez com as opções exatas', async () => {
    const filho = criarFilho();
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const spec = SPEC();
    const p = lancador.lancar(spec);
    filho.emitir('spawn');
    const d = await desfecho(p);
    assert.equal(d.tipo, 'resolvido');
    assert.deepEqual(Object.keys(d.valor).sort(), ['fluxosFechados', 'pid', 'saida']);
    assert.equal(d.valor.pid, PID);
    assert.equal((await desfecho(d.valor.saida)).tipo, 'pendente');
    assert.equal((await desfecho(d.valor.fluxosFechados)).tipo, 'pendente');
    assert.equal(s.chamadas.length, 1);
    const [chamada] = s.chamadas;
    assert.equal(chamada.executavel, spec.executavel);
    assert.deepEqual(chamada.argumentos, spec.argumentos);
    assert.deepEqual(Object.keys(chamada.opcoes).sort(), ['detached', 'env', 'shell', 'stdio']);
    assert.equal(chamada.opcoes.shell, false);
    assert.equal(chamada.opcoes.detached, true);
    assert.deepEqual(chamada.opcoes.stdio, ['ignore', DESCRITOR, 'ignore']);
    assert.deepEqual(chamada.opcoes.env, spec.ambiente);
    assert.notEqual(chamada.opcoes.env, spec.ambiente, 'cópia, não a mesma referência');
    assert.equal(lancador.situacao()[0].estado, 'INICIADO');
    assert.equal(lancador.situacao()[0].pid, PID);
  });

  teste('LAN-02b — os ouvintes são registrados de forma SÍNCRONA depois do `spawn` (os eventos reais chegam no turno seguinte): um `spawn` agendado por microtarefa não se perde', async () => {
    const s = criarSpawn({ aoLancar: (filho) => filho.emitir('spawn') });
    const d = await desfecho(criar(s.spawn).lancar(SPEC()));
    assert.equal(d.tipo, 'resolvido');
    assert.equal(d.valor.pid, PID);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-03
describe('[LAN-03] pid inválido ou ausente depois do evento `spawn`: nunca vira processo supervisionável por presunção', () => {
  const pids = [['undefined', undefined], ['null', null], ['zero', 0], ['um', 1], ['negativo', -7], ['fracionário', 1.5], ['texto', '4242'], ['NaN', Number.NaN], ['infinito', Infinity], ['acima do seguro', Number.MAX_SAFE_INTEGER + 2]];
  for (const [rotulo, pid] of pids) {
    teste(`LAN-03 (pid ${rotulo}) — rejeita com INICIO_INCONCLUSIVO: nada resolvido, nenhum pid inventado, o filho NÃO é sinalizado e fica registrado como inconclusivo`, async () => {
      const filho = criarFilho({ pid });
      const s = criarSpawn({ filho });
      const lancador = criar(s.spawn);
      const p = lancador.lancar(SPEC());
      filho.emitir('spawn');
      const d = await desfecho(p);
      assert.equal(d.tipo, 'rejeitado');
      assert.equal(d.erro.code, 'INICIO_INCONCLUSIVO');
      for (const campo of ['pid', 'saida', 'fluxosFechados']) assert.equal(Object.hasOwn(d.erro, campo), false, campo);
      assert.equal(filho.killChamadas, 0);
      const [registro] = lancador.situacao();
      assert.equal(registro.estado, 'INCONCLUSIVO');
      assert.equal(registro.pid, null, 'o pid duvidoso não é guardado como identidade');
      assert.equal(registro.grupoComprovado, false);
    });
  }

  teste('LAN-03b — o `pid` do filho é lido UMA vez (um getter que muda depois não vale): o pid devolvido é o da primeira leitura', async () => {
    const filho = criarFilho({ pid: (leitura) => (leitura === 1 ? PID : 0) });
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('spawn');
    const d = await desfecho(p);
    assert.equal(d.tipo, 'resolvido');
    assert.equal(d.valor.pid, PID);
    assert.equal(filho.leiturasDoPid, 1);
  });

  teste('LAN-03c — depois de um lançamento inconclusivo, `exit` e `close` do filho são APENAS observados: o estado continua INCONCLUSIVO e nada é promovido a supervisionável nem a encerramento seguro', async () => {
    const filho = criarFilho({ pid: 0 });
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('spawn');
    await desfecho(p);
    filho.emitir('exit', 0, null);
    filho.emitir('close', 0, null);
    const [registro] = lancador.situacao();
    assert.equal(registro.estado, 'INCONCLUSIVO');
    assert.equal(registro.terminou, true, 'o término foi observado');
    assert.equal(registro.fluxosFechados, true, 'o fechamento foi observado');
    assert.equal(registro.grupoComprovado, false, 'a identidade do grupo continua não comprovada');
    assert.equal(filho.killChamadas, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-04
describe('[LAN-04] falha DEPOIS do início: a identidade já adquirida não se perde e o processo nunca "deixa de existir" por um erro', () => {
  teste('LAN-04 — `error` depois de `spawn`: não resolve nem rejeita `saida` e `fluxosFechados`; o pid continua o mesmo; a causa segura é registrada; só o `exit` informa o término', async () => {
    const filho = criarFilho();
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('spawn');
    const { valor: processo } = await desfecho(p);
    filho.emitir('error', erroSensivel('EPIPE'));
    assert.equal((await desfecho(processo.saida)).tipo, 'pendente');
    assert.equal((await desfecho(processo.fluxosFechados)).tipo, 'pendente');
    const [registro] = lancador.situacao();
    assert.equal(registro.estado, 'INICIADO');
    assert.equal(registro.pid, PID);
    assert.equal(registro.terminou, false);
    assert.equal(registro.causa, 'EPIPE');
    assert.equal(filho.killChamadas, 0);
    filho.emitir('exit', null, 'SIGKILL');
    const d = await desfecho(processo.saida);
    assert.equal(d.tipo, 'resolvido');
    assert.deepEqual({ ...d.valor }, { codigo: null, sinal: 'SIGKILL' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-05
describe('[LAN-05] ordem dos eventos: término, fechamento dos fluxos e erro são independentes', () => {
  async function iniciado() {
    const filho = criarFilho();
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('spawn');
    const { valor: processo } = await desfecho(p);
    return { filho, lancador, processo };
  }

  teste('LAN-05 — `exit` isolado resolve `saida` e NÃO os fluxos', async () => {
    const { filho, processo } = await iniciado();
    filho.emitir('exit', 0, null);
    assert.deepEqual({ ...(await desfecho(processo.saida)).valor }, { codigo: 0, sinal: null });
    assert.equal((await desfecho(processo.fluxosFechados)).tipo, 'pendente');
  });

  teste('LAN-05b — `close` isolado resolve os fluxos e NÃO prova o término (`saida` continua pendente)', async () => {
    const { filho, processo } = await iniciado();
    filho.emitir('close', 0, null);
    assert.equal((await desfecho(processo.fluxosFechados)).tipo, 'resolvido');
    assert.equal((await desfecho(processo.saida)).tipo, 'pendente');
  });

  for (const [rotulo, ordem] of [['exit e depois close', ['exit', 'close']], ['close e depois exit', ['close', 'exit']]]) {
    teste(`LAN-05c (${rotulo}) — as duas promessas resolvem, nas duas ordens`, async () => {
      const { filho, processo } = await iniciado();
      for (const evento of ordem) filho.emitir(evento, 0, null);
      assert.equal((await desfecho(processo.saida)).tipo, 'resolvido');
      assert.equal((await desfecho(processo.fluxosFechados)).tipo, 'resolvido');
    });
  }

  teste('LAN-05d — eventos duplicados valem UMA vez: o primeiro `exit` decide (um segundo, com outro código, é ignorado) e `spawn`/`close` repetidos não mudam nada', async () => {
    const { filho, lancador, processo } = await iniciado();
    filho.emitir('spawn');
    filho.emitir('exit', 0, null);
    filho.emitir('exit', 1, null);
    filho.emitir('close', 0, null);
    filho.emitir('close', 1, null);
    assert.deepEqual({ ...(await desfecho(processo.saida)).valor }, { codigo: 0, sinal: null });
    assert.equal(lancador.situacao().length, 1, 'um lançamento só');
    assert.equal(lancador.situacao()[0].pid, PID);
  });

  const termosInvalidos = [['os dois nulos', [null, null]], ['código e sinal juntos', [1, 'SIGTERM']], ['código texto', ['0', null]], ['código NaN', [Number.NaN, null]], ['sinal vazio', [null, '']], ['sem argumentos', []]];
  for (const [rotulo, argumentos] of termosInvalidos) {
    teste(`LAN-05e (término ${rotulo}) — nunca vira "término confirmado": \`saida\` é REJEITADA com TERMINO_INVALIDO (o supervisor trata como não confirmado) e um \`exit\` válido depois não a reabilita`, async () => {
      const { filho, processo } = await iniciado();
      filho.emitir('exit', ...argumentos);
      const d = await desfecho(processo.saida);
      assert.equal(d.tipo, 'rejeitado');
      assert.equal(d.erro.code, 'TERMINO_INVALIDO');
      filho.emitir('exit', 0, null);
      assert.equal((await desfecho(processo.saida)).tipo, 'rejeitado');
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-06
describe('[LAN-06] grupo de processos: grupo próprio exigido, identidade NÃO afirmada', () => {
  teste('LAN-06 — `detached: true` e o pid do líder: o lançador não afirma identidade de grupo (`grupoComprovado` é false) e o retorno não tem campo de grupo verificado', async () => {
    const filho = criarFilho();
    const s = criarSpawn({ filho });
    const lancador = criar(s.spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('spawn');
    const { valor: processo } = await desfecho(p);
    assert.equal(s.chamadas[0].opcoes.detached, true);
    assert.equal(processo.pid, PID);
    assert.deepEqual(Object.keys(processo).sort(), ['fluxosFechados', 'pid', 'saida']);
    assert.equal(lancador.situacao()[0].grupoComprovado, false);
  });

  teste('LAN-06b — um spec sem grupo próprio (`detached: false`) é recusado antes de qualquer spawn', async () => {
    const s = criarSpawn();
    const spec = SPEC();
    spec.opcoes.detached = false;
    const d = await desfecho(criar(s.spawn).lancar(spec));
    assert.equal(d.tipo, 'rejeitado');
    assert.equal(d.erro.code, 'SPEC_INVALIDO');
    assert.equal(s.chamadas.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-07
describe('[LAN-07] lançamento inconclusivo: nada de encerramento por suposição, nada de sinal, snapshot e trava intactos', () => {
  async function descricaoComLancador(lancador) {
    const { criarProcessoDoDump } = exigirModulo('src/services/imagem-backup-pgdump.service');
    const contagem = { grupo: 0, sinal: 0, fechar: 0 };
    const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };
    const contexto = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: null });
    const dump = {
      alvo: { executavel: '/usr/lib/postgresql/16/bin/pg_dump', host: HOST, porta: 5432, usuario: USUARIO, arquivoDeSenha: SENHA_ARQUIVO, bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
      destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump' },
      lancador,
      sistema: { async grupoVivo() { contagem.grupo += 1; return false; }, async enviarSinal() { contagem.sinal += 1; return true; } },
      arquivos: { async criarExclusivo() { return { descritor: DESCRITOR, fechar() { contagem.fechar += 1; } }; } },
      temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
      prazos: { ...PRAZOS },
    };
    return { descricao: criarProcessoDoDump({ contexto, dump }), contagem };
  }

  for (const [rotulo, montar, diagnostico] of [
    ['processo comprovadamente NÃO iniciado (spawn lança)', () => criarSpawn({ lanca: erroSensivel('ENOENT') }), 'NAO_INICIADO'],
    ['processo POSSIVELMENTE iniciado (pid inválido)', () => criarSpawn({ filho: criarFilho({ pid: 0 }), aoLancar: (f) => f.emitir('spawn') }), 'INICIO_INCONCLUSIVO'],
  ]) {
    teste(`LAN-07 (${rotulo}) — pelo supervisor REAL: saída 1, trava não liberável, nenhuma consulta de grupo e nenhum sinal; o filho nunca é sinalizado; o motivo informativo ${diagnostico} acompanha INICIO_FALHOU`, async () => {
      const { supervisionar } = exigirModulo('src/services/imagem-backup-supervisor.service');
      const s = montar();
      const { descricao, contagem } = await descricaoComLancador(criar(s.spawn));
      const r = await supervisionar(descricao);
      assert.equal(r.saida, 1);
      assert.equal(r.liberarTravaPermitido, false);
      assert.equal(r.concluido, false);
      assert.deepEqual([...r.motivos], ['INICIO_FALHOU', diagnostico]);
      assert.equal(contagem.grupo + contagem.sinal, 0);
      assert.equal(s.filho.killChamadas, 0);
    });
  }

  teste('LAN-07b — as DECISÕES de segurança do supervisor são IDÊNTICAS nos dois casos (só muda o motivo informativo, que o código do lançador origina); `situacao()` do lançador continua diferenciando NAO_INICIADO de INCONCLUSIVO', async () => {
    const { supervisionar } = exigirModulo('src/services/imagem-backup-supervisor.service');
    const resultados = [];
    const estados = [];
    for (const s of [criarSpawn({ lanca: erroSensivel('ENOENT') }), criarSpawn({ filho: criarFilho({ pid: 0 }), aoLancar: (f) => f.emitir('spawn') })]) {
      const lancador = criar(s.spawn);
      const { descricao } = await descricaoComLancador(lancador);
      resultados.push(await supervisionar(descricao));
      estados.push(lancador.situacao()[0].estado);
    }
    const semMotivos = (resultado) => { const { motivos, ...resto } = JSON.parse(JSON.stringify(resultado)); return resto; };
    assert.deepEqual(semMotivos(resultados[0]), semMotivos(resultados[1]), 'saída, liberação e demais campos de segurança idênticos');
    assert.equal(resultados[0].saida, 1);
    assert.equal(resultados[0].liberarTravaPermitido, false);
    assert.deepEqual([...resultados[0].motivos], ['INICIO_FALHOU', 'NAO_INICIADO']);
    assert.deepEqual([...resultados[1].motivos], ['INICIO_FALHOU', 'INICIO_INCONCLUSIVO']);
    assert.deepEqual(estados, ['NAO_INICIADO', 'INCONCLUSIVO']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-08
describe('[LAN-08] segurança do spec: validado e copiado ANTES de qualquer spawn; ambiente e argumentos fechados', () => {
  const invalidos = [
    ['executável é um shell', (s) => { s.executavel = '/bin/sh'; }],
    ['executável relativo', (s) => { s.executavel = 'pg_dump'; }],
    ['executável com comando encadeado', (s) => { s.executavel = '/usr/bin/pg_dump; rm -rf /'; }],
    ['argumento extra', (s) => { s.argumentos.push('--file=/etc/passwd'); }],
    ['argumento com shell', (s) => { s.argumentos[3] = '--dbname=gestao_epi; id'; }],
    ['argumento --dbname como URI', (s) => { s.argumentos[3] = '--dbname=postgresql://h/db'; }],
    ['--snapshot duplicado', (s) => { s.argumentos[1] = `--snapshot=${ID_SNAPSHOT}`; }],
    ['sem --no-password', (s) => { s.argumentos.splice(1, 1); }],
    ['--jobs', (s) => { s.argumentos[1] = '--jobs=8'; }],
    ['argumentos não é lista', (s) => { s.argumentos = '--format=custom'; }],
    ['ambiente com senha', (s) => { s.ambiente.PGPASSWORD = SEGREDO; }],
    ['ambiente com variável extra', (s) => { s.ambiente.LD_PRELOAD = '/tmp/x.so'; }],
    ['ambiente sem PGPASSFILE', (s) => { delete s.ambiente.PGPASSFILE; }],
    ['ambiente com valor não texto', (s) => { s.ambiente.PGPORT = 5432; }],
    ['shell verdadeiro', (s) => { s.opcoes.shell = true; }],
    ['stdio com pipes', (s) => { s.opcoes.stdio = ['pipe', DESCRITOR, 'pipe']; }],
    ['stdout sequestrando o descritor 1', (s) => { s.opcoes.stdio = ['ignore', 1, 'ignore']; }],
    ['descritor negativo', (s) => { s.opcoes.stdio = ['ignore', -1, 'ignore']; }],
    ['opção extra (cwd)', (s) => { s.opcoes.cwd = '/'; }],
    ['opção extra (uid)', (s) => { s.opcoes.uid = 0; }],
    ['opção extra (env)', (s) => { s.opcoes.env = { PATH: '/tmp' }; }],
    ['chave extra no spec', (s) => { s.extra = 1; }],
  ];
  for (const [rotulo, ajustar] of invalidos) {
    teste(`LAN-08 (${rotulo}) — SPEC_INVALIDO: nenhum spawn, nenhum efeito, sem vazar`, async () => {
      const s = criarSpawn();
      const lancador = criar(s.spawn);
      const spec = SPEC();
      ajustar(spec);
      const d = await desfecho(lancador.lancar(spec));
      assert.equal(d.tipo, 'rejeitado');
      assert.equal(d.erro.code, 'SPEC_INVALIDO');
      assert.equal(s.chamadas.length, 0);
      assert.equal(lancador.situacao().length, 0, 'nada foi lançado');
    });
  }

  teste('LAN-08b — o ambiente do filho é EXATAMENTE o do spec: nada de `process.env` do pai', async () => {
    const antes = { senha: process.env.PGPASSWORD, outro: process.env.SEGREDO_NO_AMBIENTE_PAI };
    process.env.PGPASSWORD = SEGREDO;
    process.env.SEGREDO_NO_AMBIENTE_PAI = SEGREDO;
    try {
      const filho = criarFilho();
      const s = criarSpawn({ filho });
      const p = criar(s.spawn).lancar(SPEC());
      filho.emitir('spawn');
      await desfecho(p);
      assert.deepEqual(s.chamadas[0].opcoes.env, SPEC().ambiente);
      assert.equal(JSON.stringify(s.chamadas[0]).includes(SEGREDO), false);
    } finally {
      if (antes.senha === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = antes.senha;
      if (antes.outro === undefined) delete process.env.SEGREDO_NO_AMBIENTE_PAI; else process.env.SEGREDO_NO_AMBIENTE_PAI = antes.outro;
    }
  });

  teste('LAN-08c — o spec é capturado na chamada: mudá-lo depois (executável, argumentos, ambiente, opções) não altera o que o `spawn` recebeu', async () => {
    const filho = criarFilho();
    const s = criarSpawn({ filho });
    const spec = SPEC();
    const original = SPEC();
    const p = criar(s.spawn).lancar(spec);
    spec.executavel = '/bin/sh';
    spec.argumentos.push('--file=/etc/passwd');
    spec.ambiente.PGPASSWORD = SEGREDO;
    spec.opcoes.shell = true;
    filho.emitir('spawn');
    await desfecho(p);
    assert.equal(s.chamadas[0].executavel, original.executavel);
    assert.deepEqual(s.chamadas[0].argumentos, original.argumentos);
    assert.deepEqual(s.chamadas[0].opcoes.env, original.ambiente);
    assert.equal(s.chamadas[0].opcoes.shell, false);
  });

  teste('LAN-08d — getter hostil no spec: é recusado (SPEC_INVALIDO) sem vazar a mensagem do getter e sem spawn', async () => {
    const s = criarSpawn();
    const spec = SPEC();
    comGetter(spec, 'executavel', () => { throw new TypeError(`${SEGREDO} ${HOST} inválido`); });
    const d = await desfecho(criar(s.spawn).lancar(spec));
    assert.equal(d.tipo, 'rejeitado');
    assert.equal(d.erro.code, 'SPEC_INVALIDO');
    semMarcadores(textoPublico(d.erro), 'rejeição');
    assert.equal(s.chamadas.length, 0);
  });

  teste('LAN-08e — um `spawn` que não é função é recusado na criação do lançador (TypeError), sem lançar nada', () => {
    for (const spawn of [undefined, null, 'spawn', {}, 42]) assert.throws(() => modulo().criarLancadorComSpawn({ spawn }), TypeError);
    assert.throws(() => modulo().criarLancadorComSpawn(), TypeError);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-09
describe('[LAN-09] recursos e descritores: o fechamento da cópia do pai NÃO prova o encerramento do filho', () => {
  teste('LAN-09 — lançamento inconclusivo: o serviço do dump fecha a SUA cópia do descritor (uma vez), mas o lançador continua sem comprovar o encerramento do filho (INCONCLUSIVO, término não observado, grupo não comprovado)', async () => {
    const { criarProcessoDoDump } = exigirModulo('src/services/imagem-backup-pgdump.service');
    const filho = criarFilho({ pid: 0 });
    const s = criarSpawn({ filho, aoLancar: (f) => f.emitir('spawn') });
    const lancador = criar(s.spawn);
    let fechou = 0;
    const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };
    const contexto = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: null });
    const dump = {
      alvo: { executavel: '/usr/lib/postgresql/16/bin/pg_dump', host: HOST, porta: 5432, usuario: USUARIO, arquivoDeSenha: SENHA_ARQUIVO, bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
      destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump' },
      lancador,
      sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
      arquivos: { async criarExclusivo() { return { descritor: DESCRITOR, fechar() { fechou += 1; } }; } },
      temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
      prazos: { ...PRAZOS },
    };
    const descricao = criarProcessoDoDump({ contexto, dump });
    await assert.rejects(() => descricao.iniciar());
    assert.equal(fechou, 1, 'o pai fecha a própria cópia');
    const [registro] = lancador.situacao();
    assert.equal(registro.estado, 'INCONCLUSIVO');
    assert.equal(registro.terminou, false);
    assert.equal(registro.fluxosFechados, false);
    assert.equal(registro.grupoComprovado, false);
    assert.equal(filho.killChamadas, 0);
  });

  teste('LAN-09b — o lançador só repassa o NÚMERO do descritor: não o abre, não o fecha e não o usa como prova (o `stdio` do spawn tem o mesmo número)', async () => {
    const filho = criarFilho();
    const s = criarSpawn({ filho });
    const p = criar(s.spawn).lancar(SPEC());
    filho.emitir('spawn');
    await desfecho(p);
    assert.equal(s.chamadas[0].opcoes.stdio[1], DESCRITOR);
    assert.equal(typeof s.chamadas[0].opcoes.stdio[1], 'number');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-10
describe('[LAN-10] erros e segredos: nada de mensagem, host, usuário, senha ou caminho; diagnóstico seguro preservado', () => {
  const cenarios = [
    ['spawn lança', () => ({ s: criarSpawn({ lanca: erroSensivel('ENOENT') }), emitir: () => {} })],
    ['error antes do spawn, sem pid', () => { const filho = criarFilho({ pid: undefined }); return { s: criarSpawn({ filho }), emitir: (f) => f.emitir('error', erroSensivel('EACCES')) }; }],
    ['error antes do spawn, com pid', () => { const filho = criarFilho(); return { s: criarSpawn({ filho }), emitir: (f) => f.emitir('error', erroSensivel('EPERM')) }; }],
    ['spawn com pid inválido e error depois', () => { const filho = criarFilho({ pid: 0 }); return { s: criarSpawn({ filho }), emitir: (f) => { f.emitir('spawn'); f.emitir('error', erroSensivel('EPIPE')); } }; }],
    ['código do erro com getter que lança', () => {
      const falha = new Error(SEGREDO);
      comGetter(falha, 'code', () => { throw new Error(`${SEGREDO} ${HOST}`); });
      return { s: criarSpawn({ lanca: falha }), emitir: () => {} };
    }],
    ['código do erro com valor sensível', () => ({ s: criarSpawn({ lanca: Object.assign(new Error('x'), { code: `${SEGREDO}` }) }), emitir: () => {} })],
  ];
  for (const [rotulo, montar] of cenarios) {
    teste(`LAN-10 (${rotulo}) — rejeição, diagnóstico (\`situacao()\`) e console sem marcadores; \`code\` é um dos códigos fixos`, async () => {
      const { s, emitir } = montar();
      const lancador = criar(s.spawn);
      const { resultado: d, chamadas } = await comConsoleEspiado(async () => {
        const p = lancador.lancar(SPEC());
        emitir(s.filho);
        return desfecho(p);
      });
      assert.equal(d.tipo, 'rejeitado');
      assert.ok(CODIGOS.has(d.erro.code), `código fixo, obtido ${String(d.erro.code)}`);
      semMarcadores(textoPublico(d.erro), 'rejeição');
      semMarcadores(lancador.situacao(), 'situacao()');
      semMarcadores(chamadas.join('\n'), 'console');
      for (const registro of lancador.situacao()) assert.ok(registro.causa === null || /^[A-Z][A-Z0-9_]{1,30}$/.test(registro.causa));
    });
  }

  teste('LAN-10b — falha comprovada e estado inconclusivo continuam DISTINGUÍVEIS pelo diagnóstico seguro (`code` da rejeição e `estado`), sem expor texto', async () => {
    const a = criar(criarSpawn({ lanca: erroSensivel('ENOENT') }).spawn);
    const filho = criarFilho({ pid: 0 });
    const b = criar(criarSpawn({ filho }).spawn);
    const da = await desfecho(a.lancar(SPEC()));
    const pb = b.lancar(SPEC());
    filho.emitir('spawn');
    const db = await desfecho(pb);
    assert.notEqual(da.erro.code, db.erro.code);
    assert.deepEqual([da.erro.code, db.erro.code], ['NAO_INICIADO', 'INICIO_INCONCLUSIVO']);
    assert.deepEqual([a.situacao()[0].estado, b.situacao()[0].estado], ['NAO_INICIADO', 'INCONCLUSIVO']);
  });

  teste('LAN-10c — `situacao()` é uma fotografia CONGELADA: o chamador não altera o estado interno', async () => {
    const filho = criarFilho({ pid: 0 });
    const lancador = criar(criarSpawn({ filho }).spawn);
    const p = lancador.lancar(SPEC());
    filho.emitir('spawn');
    await desfecho(p);
    const foto = lancador.situacao();
    assert.equal(Object.isFrozen(foto), true);
    assert.equal(Object.isFrozen(foto[0]), true);
    assert.throws(() => { foto[0].estado = 'INICIADO'; }, TypeError);
    assert.equal(lancador.situacao()[0].estado, 'INCONCLUSIVO');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-11
describe('[LAN-11] exigências PRÉ-OPERACIONAIS registradas (fora deste incremento; não executam)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('LAN-11a — a execução real escolhe `child_process` INTERNAMENTE: nenhuma fábrica, `spawn` ou lançador vindo do chamador; `criarLancadorComSpawn` é só para testes', 'decisão arquitetural D8');
  todo('LAN-11b — semântica real do Node: o evento `spawn`, `pid` indefinido em falha, ordem de `exit`/`close` e `error` só se comprovam com `child_process` real', 'depende de processo real');
  todo('LAN-11c — identidade do grupo: `detached: true` + pid não provam o grupo; proteção contra reutilização de PGID (par pid/horário de início, ou handle estável) antes de qualquer sinal ou consulta', 'depende de sistema operacional real');
  todo('LAN-11d — lançamento INCONCLUSIVO: a distinção NAO_INICIADO × INCONCLUSIVO só vive no lançador; levá-la ao resultado público exige decisão sobre o supervisor ou a composição (hoje ambos viram INICIO_FALHOU com trava retida)', 'bloqueio arquitetural');
  todo('LAN-11e — o supervisor aceita `pgid` 1 (só recusa ≤ 0): endurecer (pgid > 1) ou garantir a recusa em toda composição; `kill(-1)` seria catastrófico', 'requer mudança no supervisor');
  todo('LAN-11f — processo órfão de um lançamento inconclusivo: política operacional (alerta, retenção permanente da trava, procedimento de recuperação) e histórico limitado de `situacao()`', 'decisão operacional');
  todo('LAN-11g — descritores reais: o descritor passado em `stdio` precisa existir e pertencer ao arquivo criado de forma exclusiva; verificação no sistema operacional', 'depende de sistema de arquivos real');
});

// ------------------------------------------------------------------------------------------------------------------------------- LAN-TLS
describe('[LAN-TLS] D-F7: par PGSSLMODE/PGSSLROOTCERT opt-in no ambiente do dump', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const pasta = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dump-tls-'));
  const cert = path.join(pasta, 'ca.pem');
  fs.writeFileSync(cert, 'sintetico', { mode: 0o600 });
  require('node:test').after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  const comAmbiente = (extra) => ({ ...SPEC(), ambiente: { ...SPEC().ambiente, ...extra } });

  teste('LAN-TLS-01 — com o par válido e host por nome o spawn recebe seis chaves; sem o par continua com quatro', async () => {
    const a = criarSpawn({ lanca: erroSensivel('EINVAL') });
    await desfecho(criar(a.spawn).lancar(comAmbiente({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert })));
    assert.deepEqual(Object.keys(a.chamadas[0].opcoes.env).sort(), ['PGHOST', 'PGPASSFILE', 'PGPORT', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGUSER']);
    const b = criarSpawn({ lanca: erroSensivel('EINVAL') });
    await desfecho(criar(b.spawn).lancar(SPEC()));
    assert.deepEqual(Object.keys(b.chamadas[0].opcoes.env).sort(), ['PGHOST', 'PGPASSFILE', 'PGPORT', 'PGUSER']);
  });

  teste('LAN-TLS-02 — par incompleto, modo fraco, CA insegura/inexistente ou chave extra: SPEC_INVALIDO e nenhum spawn', async () => {
    const frouxo = path.join(pasta, 'frouxo.pem');
    fs.writeFileSync(frouxo, 'x'); fs.chmodSync(frouxo, 0o666);
    for (const extra of [
      { PGSSLMODE: 'verify-full' }, { PGSSLROOTCERT: cert }, { PGSSLMODE: 'require', PGSSLROOTCERT: cert },
      { PGSSLMODE: 'verify-full', PGSSLROOTCERT: frouxo }, { PGSSLMODE: 'verify-full', PGSSLROOTCERT: path.join(pasta, 'nao.pem') },
      { PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert, PGSSLCERT: '/x' },
    ]) {
      const s = criarSpawn();
      const d = await desfecho(criar(s.spawn).lancar(comAmbiente(extra)));
      assert.equal(d.tipo, 'rejeitado');
      assert.equal(d.erro.code, 'SPEC_INVALIDO');
      assert.equal(s.chamadas.length, 0);
    }
  });
});
