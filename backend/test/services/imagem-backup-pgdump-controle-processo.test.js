'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-CONTROLE-PROCESSO-1): CONTROLADOR de processo POR OPERAÇÃO. Só unitário e em memória: o `spawn`, o
 * filho, os eventos, o observador de grupo, o relógio e `process.kill` (espiado e proibido) são falsos; nenhum processo, sinal, PostgreSQL ou arquivo reais.
 * Sincronização por promessas controladas e por um único `setImmediate` de descarga; cada teste tem prazo próprio.
 *
 * CONTRATO REAL CONFIRMADO (lido no código): o serviço do dump consome `dump.lancador.lancar(spec)` -> `{ pid, saida, fluxosFechados }` e `dump.sistema.grupoVivo(pgid)`
 * / `dump.sistema.enviarSinal(pgid, sinal)`, capturando os MÉTODOS uma vez e chamando-os com o `this` de origem; o supervisor chama `grupo.vivos(pgid)` e
 * `sinais.enviar(pgid, sinal)` só depois de aceitar `pgid > 1`. Hoje essas peças recebem apenas o NÚMERO: nada vincula o pedido de sinal ao filho realmente lançado.
 *
 * INTERFACE INTERNA MÍNIMA PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado nesta fase):
 *   src/services/imagem-backup-pgdump-controle-processo.service.js exporta `criarControleDeProcesso({ spawn, observarGrupo, relogio? })` -> congelado
 *   { lancador: { lancar(spec) }, sistema: { grupoVivo(pgid), enviarSinal(pgid, sinal) }, situacao(), registroDeRecuperacao() }.
 *   `spawn` e `observarGrupo` são injetados SÓ para este contrato provisório e os testes (D8): a execução real escolherá `child_process` e o observador INTERNAMENTE.
 *   Um controle por OPERAÇÃO e de USO ÚNICO. Compatível com o consumo atual: `dump.lancador = controle.lancador` e `dump.sistema = controle.sistema`, sem tocar o
 *   serviço do dump nem o supervisor.
 *   - `lancador.lancar(spec)`: mesma validação, mesmos códigos e mesmo retorno do lançador provisório (NAO_INICIADO, INICIO_INCONCLUSIVO, SPEC_INVALIDO), mais
 *     LANCAMENTO_JA_REALIZADO para qualquer segunda chamada (a referência do filho não pode ser substituída). Guarda o filho REALMENTE devolvido pelo `spawn`, o
 *     `kill` dele lido UMA vez, o `pid` lido UMA vez e a identidade opaca da operação (`operacaoId`, 32 hex, sem relação com o pid).
 *   - `sistema.enviarSinal(pgid, sinal)`: só SIGINT, SIGTERM ou SIGKILL, só para o pgid DESTE controle com lançamento confirmado, só enquanto o `exit` do filho não foi
 *     observado; envia pelo `kill` capturado (nunca `process.kill`, nunca por número); responde true só se o `kill` devolveu true; qualquer outro caso: false.
 *     Um sinal aceito NÃO prova nada: o término continua dependendo do `exit`.
 *   - `sistema.grupoVivo(pgid)`: pergunta ao `observarGrupo` SEMPRE (antes e depois do `exit` do líder); só `true`/`false` do observador valem; qualquer outra resposta,
 *     exceção ou pgid alheio REJEITA (nunca vira "vazio"); lançamento não confirmado nunca consulta o observador.
 *   - `situacao()`: { operacaoId, estado (NAO_LANCADO | NAO_INICIADO | INICIADO | INCONCLUSIVO), pid | null, terminou, fluxosFechados, grupo (NAO_OBSERVADO | POVOADO |
 *     VAZIO_OBSERVADO | INCONCLUSIVO), grupoComprovado: false, causa | null }. "VAZIO_OBSERVADO" é uma OBSERVAÇÃO, nunca prova de identidade imutável do grupo.
 *   - `registroDeRecuperacao()`: metadados mínimos e não secretos { versao, operacaoId, estado, pidDoFilho | null, iniciadoEm | null, executavel (só o nome),
 *     provaSuficienteParaSinal: false, autorizaLiberarTrava: false }. NUNCA o snapshotId, o ambiente, os argumentos, o caminho completo nem credenciais. Esta fase só ESPECIFICA:
 *     nenhum registro é gravado em disco, e linha de comando e horário de início NÃO são prova suficiente para enviar sinais a um processo.
 *
 * LIMITES DE COMPROVAÇÃO (honestidade): estes testes com doubles verificam DECISÕES de autorização do controlador. Eles NÃO provam atomicidade da sinalização, a semântica
 * real de `ChildProcess.kill` (a documentação pública do Node.js reconhece o risco de reutilização de PID depois do término), reutilização de PID/PGID, identidade do
 * grupo depois do término do líder, contenção e permissões em Linux, processos órfãos nem recuperação depois da morte do orquestrador: tudo isso continua PENDENTE de
 * validação real (ver os TODO CTR-09).
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje e fixam as peças reais com as quais o
 * controlador precisa ser compatível.
 */

const MODULO = 'src/services/imagem-backup-pgdump-controle-processo.service';
const modulo = () => exigirModulo(MODULO);
const PRAZO_DO_TESTE = 10000;
const PID = 4242;
const OUTRO_PID = 5151;
const DESCRITOR = 77;
const ID_SNAPSHOT = '0000000A-0000002B-7';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const HOST = 'db.interno.exemplo';
const USUARIO = 'usuario_secreto';
const SENHA_ARQUIVO = '/etc/safework/pgpass';
const MARCADORES = [SEGREDO, HOST, USUARIO, 'postgres://', 'password', ID_SNAPSHOT, SENHA_ARQUIVO];
const INSTANTE = 1760000000000;
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const OPACO = /^[0-9a-f]{32}$/;

const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);
const descarga = () => new Promise((resolver) => setImmediate(resolver));

async function desfecho(promessa) {
  return Promise.race([
    promessa.then((valor) => ({ tipo: 'resolvido', valor }), (erro) => ({ tipo: 'rejeitado', erro })),
    descarga().then(() => ({ tipo: 'pendente' })),
  ]);
}

function erroSensivel(codigo = 'EACCES') {
  return Object.assign(new Error(`falha ${SENHA_ARQUIVO} password=${SEGREDO} host=${HOST} user=${USUARIO} snapshot=${ID_SNAPSHOT}`), { code: codigo, detail: SEGREDO });
}

function semMarcadores(valor, rotulo) {
  const texto = typeof valor === 'string' ? valor : (JSON.stringify(valor) ?? String(valor));
  for (const marcador of MARCADORES) assert.equal(texto.includes(marcador), false, `${rotulo}: não pode conter "${marcador}"`);
}

const textoPublico = (erro) => `${erro.message} ${String(erro)} ${JSON.stringify(erro)} ${String(erro.code)}`;

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

/** `process.kill` é PROIBIDO nestes fluxos: espiado e lança, para nunca atingir nada real. */
async function semProcessKill(fn) {
  const original = process.kill;
  const chamadas = [];
  process.kill = (...argumentos) => { chamadas.push(argumentos); throw new Error('process.kill é proibido neste fluxo'); };
  try {
    return { resultado: await fn(), chamadas };
  } finally {
    process.kill = original;
  }
}

/** Filho falso: emissor mínimo; `pid` configurável (valor, `undefined` explícito preservado); `kill` registra os sinais e pode devolver false ou lançar. */
function criarFilho(opcoes = {}) {
  const pid = Object.hasOwn(opcoes, 'pid') ? opcoes.pid : PID;
  const ouvintes = {};
  const filho = {
    sinais: [],
    killRetorno: true,
    killLanca: null,
    aoKill: null,
    on(evento, f) { (ouvintes[evento] ??= []).push(f); return filho; },
    emitir(evento, ...argumentos) { for (const f of [...(ouvintes[evento] ?? [])]) f(...argumentos); },
    kill(sinal) {
      filho.sinais.push(sinal);
      if (filho.killLanca) throw filho.killLanca;
      if (filho.aoKill) filho.aoKill(sinal);
      return filho.killRetorno;
    },
  };
  let pidAtual = pid;
  Object.defineProperty(filho, 'pid', { enumerable: true, get: () => pidAtual });
  filho.trocarPid = (novo) => { pidAtual = novo; };
  return filho;
}

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

/** Observador de grupo falso: `resposta` é valor fixo, função, ou Error (lançado). Registra os pgids consultados. */
function criarObservador(resposta) {
  // Sem argumentos: resposta padrão `false`. `undefined` EXPLÍCITO é preservado (um valor padrão de parâmetro o substituiria); qualquer outro valor também.
  if (arguments.length === 0) resposta = false;
  const chamadas = [];
  return {
    chamadas,
    observar(pgid) {
      chamadas.push(pgid);
      const valor = typeof resposta === 'function' ? resposta(pgid) : resposta;
      if (valor instanceof Error) throw valor;
      return valor;
    },
  };
}

const SPEC = () => ({
  executavel: '/usr/lib/postgresql/16/bin/pg_dump',
  argumentos: ['--format=custom', '--no-password', `--snapshot=${ID_SNAPSHOT}`, '--dbname=gestao_epi'],
  ambiente: { PGPASSFILE: SENHA_ARQUIVO, PGHOST: HOST, PGPORT: '5432', PGUSER: USUARIO },
  opcoes: { shell: false, detached: true, stdio: ['ignore', DESCRITOR, 'ignore'] },
});

const criarControle = (spawn, observador = criarObservador(false)) => modulo().criarControleDeProcesso({ spawn, observarGrupo: observador.observar, relogio: () => INSTANTE });

/** Lança e confirma o início (evento `spawn`), devolvendo tudo o que os testes precisam. */
async function lancado({ filho = criarFilho(), observador = criarObservador(false) } = {}) {
  const s = criarSpawn({ filho });
  const controle = criarControle(s.spawn, observador);
  const p = controle.lancador.lancar(SPEC());
  filho.emitir('spawn');
  const { valor: processo } = await desfecho(p);
  return { controle, filho, processo, observador, s };
}

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: o consumo atual dessas peças pelo serviço do dump e pelo supervisor', () => {
  teste('CTL-01 — o serviço do dump aceita `lancador` e `sistema` com os métodos `lancar`, `grupoVivo` e `enviarSinal` e os chama com o `this` de origem (a forma que o controlador precisa ter)', async () => {
    const { criarProcessoDoDump } = exigirModulo('src/services/imagem-backup-pgdump.service');
    const vistos = [];
    const lancador = { id: 'L', async lancar() { vistos.push(this === lancador); return { pid: PID, saida: new Promise(() => {}), fluxosFechados: new Promise(() => {}) }; } };
    const sistema = { id: 'S', async grupoVivo() { vistos.push(this === sistema); return false; }, async enviarSinal() { vistos.push(this === sistema); return true; } };
    const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };
    const contexto = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: null });
    const dump = {
      alvo: { executavel: '/usr/lib/postgresql/16/bin/pg_dump', host: HOST, porta: 5432, usuario: USUARIO, arquivoDeSenha: SENHA_ARQUIVO, bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
      destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump' },
      lancador,
      sistema,
      arquivos: { async criarExclusivo() { return { descritor: DESCRITOR, fechar() {} }; } },
      temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
      prazos: { ...PRAZOS },
    };
    const descricao = criarProcessoDoDump({ contexto, dump });
    const processo = await descricao.iniciar();
    await descricao.grupo.vivos(processo.pgid);
    await descricao.sinais.enviar(processo.pgid, 'SIGTERM');
    assert.deepEqual(vistos, [true, true, true]);
  });

  teste('CTL-02 — o filho falso registra sinais, emite eventos e preserva `pid: undefined` explícito; o espião de `process.kill` bloqueia e registra', async () => {
    const filho = criarFilho({ pid: undefined });
    assert.equal(filho.pid, undefined);
    assert.equal(filho.kill('SIGTERM'), true);
    assert.deepEqual(filho.sinais, ['SIGTERM']);
    const { chamadas } = await semProcessKill(async () => { try { process.kill(-PID, 'SIGTERM'); } catch { /* bloqueado */ } });
    assert.deepEqual(chamadas, [[-PID, 'SIGTERM']]);
    assert.notEqual(process.kill.toString().includes('process.kill é proibido'), true, 'restaurado');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-01
describe('[CTR-01] identidade por operação: nenhuma autorização é compartilhada, e um PID coincidente não é identidade', () => {
  teste('CTR-01 — dois controles com o MESMO pid numérico e filhos distintos: o sinal pedido a um só atinge o filho DELE', async () => {
    const a = await lancado({ filho: criarFilho({ pid: PID }) });
    const b = await lancado({ filho: criarFilho({ pid: PID }) });
    const { chamadas } = await semProcessKill(async () => {
      assert.equal(await a.controle.sistema.enviarSinal(PID, 'SIGTERM'), true);
      assert.equal(await b.controle.sistema.enviarSinal(PID, 'SIGKILL'), true);
    });
    assert.deepEqual(chamadas, []);
    assert.deepEqual(a.filho.sinais, ['SIGTERM']);
    assert.deepEqual(b.filho.sinais, ['SIGKILL']);
  });

  teste('CTR-01b — o pgid de OUTRA operação (outro pid) não autoriza nada: false, nenhum `kill`, nenhuma consulta de grupo', async () => {
    const a = await lancado({ filho: criarFilho({ pid: PID }) });
    const b = await lancado({ filho: criarFilho({ pid: OUTRO_PID }) });
    assert.equal(await a.controle.sistema.enviarSinal(OUTRO_PID, 'SIGTERM'), false);
    await assert.rejects(() => a.controle.sistema.grupoVivo(OUTRO_PID));
    assert.deepEqual(a.filho.sinais, []);
    assert.deepEqual(b.filho.sinais, []);
    assert.deepEqual(a.observador.chamadas, []);
  });

  teste('CTR-01c — a identidade da operação é OPACA e única: 32 hex, diferente entre controles com o mesmo pid, e não derivada do pid', async () => {
    const a = await lancado({ filho: criarFilho({ pid: PID }) });
    const b = await lancado({ filho: criarFilho({ pid: PID }) });
    const ia = a.controle.situacao().operacaoId;
    const ib = b.controle.situacao().operacaoId;
    assert.match(ia, OPACO);
    assert.match(ib, OPACO);
    assert.notEqual(ia, ib);
    assert.equal(a.controle.registroDeRecuperacao().operacaoId, ia);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-02
describe('[CTR-02] referência estável: o filho e suas operações ficam presos ao lançamento', () => {
  teste('CTR-02 — o `kill` do filho é lido UMA vez no lançamento: trocá-lo depois não tem efeito', async () => {
    const { controle, filho } = await lancado();
    let hostil = 0;
    const original = filho.kill;
    filho.kill = () => { hostil += 1; return true; };
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), true);
    assert.equal(hostil, 0, 'a função trocada nunca é chamada');
    assert.deepEqual(filho.sinais, ['SIGTERM'], 'o kill original (capturado) foi o usado');
    filho.kill = original;
  });

  teste('CTR-02b — o `pid` do filho é lido UMA vez: trocar o getter depois não muda a autorização', async () => {
    const { controle, filho } = await lancado();
    filho.trocarPid(OUTRO_PID);
    assert.equal(await controle.sistema.enviarSinal(OUTRO_PID, 'SIGTERM'), false);
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), true);
    assert.deepEqual(filho.sinais, ['SIGTERM']);
  });

  teste('CTR-02c — USO ÚNICO: uma segunda chamada a `lancar` é recusada (LANCAMENTO_JA_REALIZADO) e o `spawn` NÃO é chamado de novo; o filho original continua o controlado', async () => {
    const { controle, filho, s } = await lancado();
    const d = await desfecho(controle.lancador.lancar(SPEC()));
    assert.equal(d.tipo, 'rejeitado');
    assert.equal(d.erro.code, 'LANCAMENTO_JA_REALIZADO');
    assert.equal(s.chamadas.length, 1);
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGINT'), true);
    assert.deepEqual(filho.sinais, ['SIGINT']);
  });

  teste('CTR-02d — o controle e suas partes são CONGELADOS: o chamador não substitui `enviarSinal`, `grupoVivo`, `lancar` nem `situacao`', async () => {
    const { controle } = await lancado();
    for (const objeto of [controle, controle.lancador, controle.sistema]) assert.equal(Object.isFrozen(objeto), true);
    assert.throws(() => { controle.sistema.enviarSinal = () => true; }, TypeError);
    assert.throws(() => { controle.lancador.lancar = () => Promise.resolve({}); }, TypeError);
    assert.throws(() => { controle.situacao = () => ({}); }, TypeError);
  });

  teste('CTR-02e — a validação do spec é a do lançador: spec inválido é recusado (SPEC_INVALIDO), o `spawn` nunca é chamado e o controle NÃO é consumido', async () => {
    const s = criarSpawn();
    const controle = criarControle(s.spawn);
    const invalido = SPEC();
    invalido.executavel = '/bin/sh';
    const d = await desfecho(controle.lancador.lancar(invalido));
    assert.equal(d.erro.code, 'SPEC_INVALIDO');
    assert.equal(s.chamadas.length, 0);
    const p = controle.lancador.lancar(SPEC());
    s.filho.emitir('spawn');
    assert.equal((await desfecho(p)).tipo, 'resolvido', 'um spec válido ainda pode ser lançado');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-03
describe('[CTR-03] lançamento inconclusivo ou não iniciado: nenhuma autorização, nenhum "vazio", diagnóstico conservador', () => {
  const pids = [['undefined', undefined], ['zero', 0], ['um', 1], ['negativo', -1], ['fracionário', 1.5]];
  for (const [rotulo, pid] of pids) {
    teste(`CTR-03 (pid ${rotulo} depois do evento spawn) — INICIO_INCONCLUSIVO: nenhum sinal por pid nem pelo filho, o observador nunca é consultado, o grupo nunca é "vazio", estado INCONCLUSIVO`, async () => {
      const filho = criarFilho({ pid });
      const observador = criarObservador(false);
      const s = criarSpawn({ filho });
      const controle = criarControle(s.spawn, observador);
      const p = controle.lancador.lancar(SPEC());
      filho.emitir('spawn');
      const d = await desfecho(p);
      assert.equal(d.tipo, 'rejeitado');
      assert.equal(d.erro.code, 'INICIO_INCONCLUSIVO');
      for (const alvo of [PID, OUTRO_PID, 1, 0, pid]) {
        assert.equal(await controle.sistema.enviarSinal(alvo, 'SIGTERM'), false);
        assert.equal(await controle.sistema.enviarSinal(alvo, 'SIGKILL'), false);
        await assert.rejects(() => controle.sistema.grupoVivo(alvo));
      }
      assert.deepEqual(filho.sinais, []);
      assert.deepEqual(observador.chamadas, []);
      const situacao = controle.situacao();
      assert.equal(situacao.estado, 'INCONCLUSIVO');
      assert.equal(situacao.pid, null);
      assert.notEqual(situacao.grupo, 'VAZIO_OBSERVADO');
      assert.equal(situacao.grupoComprovado, false);
      assert.equal(controle.registroDeRecuperacao().estado, 'INCONCLUSIVO');
      assert.equal(controle.registroDeRecuperacao().pidDoFilho, null);
    });
  }

  teste('CTR-03b — `error` ANTES de `spawn` com pid presente também é inconclusivo: mesmas proibições', async () => {
    const filho = criarFilho({ pid: PID });
    const observador = criarObservador(false);
    const controle = criarControle(criarSpawn({ filho }).spawn, observador);
    const p = controle.lancador.lancar(SPEC());
    filho.emitir('error', erroSensivel('EPERM'));
    assert.equal((await desfecho(p)).erro.code, 'INICIO_INCONCLUSIVO');
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGKILL'), false);
    await assert.rejects(() => controle.sistema.grupoVivo(PID));
    assert.deepEqual(filho.sinais, []);
    assert.deepEqual(observador.chamadas, []);
    assert.equal(controle.situacao().estado, 'INCONCLUSIVO');
  });

  teste('CTR-03c — depois de um lançamento inconclusivo, `exit` e `close` são só OBSERVADOS: o estado continua INCONCLUSIVO, o grupo continua sem prova e nada é sinalizado', async () => {
    const filho = criarFilho({ pid: 0 });
    const controle = criarControle(criarSpawn({ filho }).spawn);
    const p = controle.lancador.lancar(SPEC());
    filho.emitir('spawn');
    await desfecho(p);
    filho.emitir('exit', 0, null);
    filho.emitir('close', 0, null);
    const situacao = controle.situacao();
    assert.equal(situacao.estado, 'INCONCLUSIVO');
    assert.equal(situacao.terminou, true);
    assert.equal(situacao.fluxosFechados, true);
    assert.notEqual(situacao.grupo, 'VAZIO_OBSERVADO');
    assert.equal(situacao.grupoComprovado, false);
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), false);
    assert.deepEqual(filho.sinais, []);
  });

  teste('CTR-03d — falha COMPROVADA (spawn lança): NAO_INICIADO; sem sinal, sem observador, o grupo nunca é "vazio"', async () => {
    const observador = criarObservador(false);
    const s = criarSpawn({ lanca: erroSensivel('ENOENT') });
    const controle = criarControle(s.spawn, observador);
    const d = await desfecho(controle.lancador.lancar(SPEC()));
    assert.equal(d.erro.code, 'NAO_INICIADO');
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), false);
    await assert.rejects(() => controle.sistema.grupoVivo(PID));
    assert.deepEqual(observador.chamadas, []);
    assert.equal(controle.situacao().estado, 'NAO_INICIADO');
    assert.equal(controle.situacao().pid, null);
  });

  teste('CTR-03e — antes de qualquer lançamento: estado NAO_LANCADO, nenhuma autorização, nenhuma consulta', async () => {
    const observador = criarObservador(false);
    const controle = criarControle(criarSpawn().spawn, observador);
    assert.equal(controle.situacao().estado, 'NAO_LANCADO');
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), false);
    await assert.rejects(() => controle.sistema.grupoVivo(PID));
    assert.deepEqual(observador.chamadas, []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-04
describe('[CTR-04] sinais: só os permitidos, só para a operação certa, só pelo `kill` capturado, nunca `process.kill`, nunca depois do término observado', () => {
  teste('CTR-04 — SIGINT, SIGTERM e SIGKILL são aceitos e chegam ao filho pelo `kill` capturado; `process.kill` nunca é chamado', async () => {
    const { controle, filho } = await lancado();
    const { chamadas } = await semProcessKill(async () => {
      for (const sinal of ['SIGINT', 'SIGTERM', 'SIGKILL']) assert.equal(await controle.sistema.enviarSinal(PID, sinal), true);
    });
    assert.deepEqual(chamadas, []);
    assert.deepEqual(filho.sinais, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  });

  for (const [rotulo, sinal] of [['SIGSTOP', 'SIGSTOP'], ['SIGUSR1', 'SIGUSR1'], ['SIGHUP', 'SIGHUP'], ['0', '0'], ['vazio', ''], ['número 9', 9], ['minúsculas', 'sigterm'], ['nulo', null], ['objeto', { toString: () => 'SIGTERM' }]]) {
    teste(`CTR-04b (sinal ${rotulo}) — fora da lista: false, nenhum \`kill\``, async () => {
      const { controle, filho } = await lancado();
      assert.equal(await controle.sistema.enviarSinal(PID, sinal), false);
      assert.deepEqual(filho.sinais, []);
    });
  }

  for (const [rotulo, alvo] of [['pgid de outra operação', OUTRO_PID], ['negativo (grupo)', -PID], ['1', 1], ['0', 0], ['texto', String(PID)], ['undefined', undefined]]) {
    teste(`CTR-04c (alvo ${rotulo}) — pedido para um alvo que não é o pgid desta operação: false, nenhum \`kill\`, nenhum \`process.kill\``, async () => {
      const { controle, filho } = await lancado();
      const { chamadas } = await semProcessKill(async () => assert.equal(await controle.sistema.enviarSinal(alvo, 'SIGKILL'), false));
      assert.deepEqual(chamadas, []);
      assert.deepEqual(filho.sinais, []);
    });
  }

  teste('CTR-04d — depois do `exit` OBSERVADO nenhum novo sinal é solicitado ao filho (false); antes do `exit`, ainda é. (Isso reduz a janela, mas NÃO é garantia atômica contra saída simultânea e reutilização de PID)', async () => {
    const { controle, filho } = await lancado();
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), true);
    filho.emitir('exit', null, 'SIGTERM');
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGKILL'), false);
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGINT'), false);
    assert.deepEqual(filho.sinais, ['SIGTERM']);
  });

  teste('CTR-04e — o `kill` que devolve false ou lança NÃO é "aceito": false, e a exceção sensível não vaza nem derruba o controlador', async () => {
    const { controle, filho } = await lancado();
    filho.killRetorno = false;
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), false);
    filho.killRetorno = true;
    filho.killLanca = erroSensivel('EPERM');
    const { resultado, chamadas } = await comConsoleEspiado(() => controle.sistema.enviarSinal(PID, 'SIGKILL'));
    assert.equal(resultado, false);
    semMarcadores(chamadas.join('\n'), 'console');
    semMarcadores(controle.situacao(), 'situacao');
    assert.equal(controle.situacao().estado, 'INICIADO', 'a falha do kill não apaga a identidade nem declara término');
  });

  teste('CTR-04f — um sinal aceito NÃO prova o término: `terminou`, `fluxosFechados` e o grupo continuam como estavam até os eventos e a observação', async () => {
    const { controle } = await lancado();
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGKILL'), true);
    const situacao = controle.situacao();
    assert.equal(situacao.terminou, false);
    assert.equal(situacao.fluxosFechados, false);
    assert.equal(situacao.grupo, 'NAO_OBSERVADO');
    assert.equal(situacao.estado, 'INICIADO');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-05
describe('[CTR-05] grupo: observação INDEPENDENTE do término do líder; resposta desconhecida nunca é "vazio"; identidade nunca é comprovada por número', () => {
  teste('CTR-05 — o observador é consultado ANTES do término do líder (sem atalho): `true` devolve true; o pgid consultado é o desta operação', async () => {
    const { controle, observador } = await lancado({ observador: criarObservador(true) });
    assert.equal(await controle.sistema.grupoVivo(PID), true);
    assert.deepEqual(observador.chamadas, [PID]);
    assert.equal(controle.situacao().grupo, 'POVOADO');
  });

  teste('CTR-05b — depois de `exit` e `close` o observador AINDA é consultado: nada é inferido do término do líder; `true` (descendentes) devolve true e `false` devolve false', async () => {
    const povoado = await lancado({ observador: criarObservador(true) });
    povoado.filho.emitir('exit', 0, null);
    povoado.filho.emitir('close', 0, null);
    assert.equal(await povoado.controle.sistema.grupoVivo(PID), true);
    assert.deepEqual(povoado.observador.chamadas, [PID]);
    const vazio = await lancado({ observador: criarObservador(false) });
    vazio.filho.emitir('exit', 0, null);
    vazio.filho.emitir('close', 0, null);
    assert.equal(await vazio.controle.sistema.grupoVivo(PID), false);
    assert.deepEqual(vazio.observador.chamadas, [PID]);
    assert.equal(vazio.controle.situacao().grupo, 'VAZIO_OBSERVADO');
  });

  teste('CTR-05c — "vazio observado" NUNCA vira prova de identidade: `grupoComprovado` continua false, e o registro de recuperação não autoriza sinal nem liberação', async () => {
    const { controle, filho } = await lancado({ observador: criarObservador(false) });
    filho.emitir('exit', 0, null);
    filho.emitir('close', 0, null);
    await controle.sistema.grupoVivo(PID);
    assert.equal(controle.situacao().grupoComprovado, false);
    const registro = controle.registroDeRecuperacao();
    assert.equal(registro.provaSuficienteParaSinal, false);
    assert.equal(registro.autorizaLiberarTrava, false);
  });

  for (const [rotulo, resposta] of [['undefined', undefined], ['null', null], ['texto "false"', 'false'], ['número 0', 0], ['objeto', {}], ['lista vazia', []]]) {
    teste(`CTR-05d (observador devolve ${rotulo}) — resposta desconhecida REJEITA: nunca vira "grupo vazio"; estado do grupo INCONCLUSIVO`, async () => {
      const { controle } = await lancado({ observador: criarObservador(resposta) });
      await assert.rejects(() => controle.sistema.grupoVivo(PID));
      assert.equal(controle.situacao().grupo, 'INCONCLUSIVO');
    });
  }

  teste('CTR-05e — o observador que LANÇA (exceção sensível) REJEITA com erro seguro e o estado do grupo fica INCONCLUSIVO; mesmo com o líder já encerrado, a falha da observação não vira "vazio"', async () => {
    const { controle, filho } = await lancado({ observador: criarObservador(erroSensivel('EPERM')) });
    filho.emitir('exit', 0, null);
    filho.emitir('close', 0, null);
    const { resultado: d, chamadas } = await comConsoleEspiado(() => desfecho(controle.sistema.grupoVivo(PID)));
    assert.equal(d.tipo, 'rejeitado');
    semMarcadores(textoPublico(d.erro), 'rejeição');
    semMarcadores(chamadas.join('\n'), 'console');
    assert.equal(controle.situacao().grupo, 'INCONCLUSIVO');
  });

  teste('CTR-05f — pgid alheio ou consulta antes do lançamento rejeitam SEM consultar o observador', async () => {
    const { controle, observador } = await lancado();
    for (const alvo of [OUTRO_PID, 1, 0, -PID, String(PID), undefined]) await assert.rejects(() => controle.sistema.grupoVivo(alvo));
    assert.deepEqual(observador.chamadas, []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-06
describe('[CTR-06] falhas e perda de observabilidade: nenhum desses estados autoriza liberar a trava ou finalizar o snapshot', () => {
  teste('CTR-06 — `error` DEPOIS do início não apaga a identidade: o estado continua INICIADO, o pid o mesmo, o sinal ainda chega ao MESMO filho, a causa fica registrada em código seguro', async () => {
    const { controle, filho } = await lancado();
    filho.emitir('error', erroSensivel('EPIPE'));
    const situacao = controle.situacao();
    assert.equal(situacao.estado, 'INICIADO');
    assert.equal(situacao.pid, PID);
    assert.equal(situacao.causa, 'EPIPE');
    assert.equal(await controle.sistema.enviarSinal(PID, 'SIGTERM'), true);
    assert.deepEqual(filho.sinais, ['SIGTERM']);
  });

  teste('CTR-06b — o REGISTRO DE RECUPERAÇÃO é mínimo, não secreto e NUNCA autoriza nada: chaves exatas; sem snapshotId, ambiente, argumentos nem caminho completo; instante do relógio injetado; provaSuficienteParaSinal e autorizaLiberarTrava false', async () => {
    const { controle } = await lancado();
    const registro = controle.registroDeRecuperacao();
    assert.deepEqual(Object.keys(registro).sort(), ['autorizaLiberarTrava', 'estado', 'executavel', 'iniciadoEm', 'operacaoId', 'pidDoFilho', 'provaSuficienteParaSinal', 'versao']);
    assert.equal(registro.versao, 1);
    assert.equal(registro.estado, 'INICIADO');
    assert.equal(registro.pidDoFilho, PID);
    assert.equal(registro.iniciadoEm, new Date(INSTANTE).toISOString());
    assert.equal(registro.executavel, 'pg_dump');
    assert.equal(registro.provaSuficienteParaSinal, false);
    assert.equal(registro.autorizaLiberarTrava, false);
    assert.match(registro.operacaoId, OPACO);
    semMarcadores(registro, 'registro de recuperação');
    assert.equal(Object.isFrozen(registro), true);
    assert.throws(() => { registro.provaSuficienteParaSinal = true; }, TypeError);
    assert.equal(controle.registroDeRecuperacao().provaSuficienteParaSinal, false);
  });

  teste('CTR-06c — o registro é PURO: pedi-lo não chama o observador, não sinaliza e não grava nada; antes do lançamento ele existe com estado NAO_LANCADO e sem pid nem instante', async () => {
    const observador = criarObservador(true);
    const s = criarSpawn();
    const controle = criarControle(s.spawn, observador);
    const registro = controle.registroDeRecuperacao();
    assert.equal(registro.estado, 'NAO_LANCADO');
    assert.equal(registro.pidDoFilho, null);
    assert.equal(registro.iniciadoEm, null);
    assert.deepEqual(observador.chamadas, []);
    assert.deepEqual(s.filho.sinais, []);
  });

  teste('CTR-06d — PERDA DE OBSERVABILIDADE (o filho nunca emite `exit`/`close` e o observador falha): nada vira término nem "vazio"; a situação diz exatamente isso', async () => {
    const { controle } = await lancado({ observador: criarObservador(erroSensivel('EPERM')) });
    await assert.rejects(() => controle.sistema.grupoVivo(PID));
    const situacao = controle.situacao();
    assert.equal(situacao.terminou, false);
    assert.equal(situacao.fluxosFechados, false);
    assert.equal(situacao.grupo, 'INCONCLUSIVO');
    assert.equal(situacao.estado, 'INICIADO');
    assert.equal(controle.registroDeRecuperacao().autorizaLiberarTrava, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-07
describe('[CTR-07] sigilo: o estado público tem só códigos fixos e a identidade opaca', () => {
  teste('CTR-07 — situacao(), registro e rejeições nunca contêm mensagem, host, usuário, senha, caminho da senha, ambiente nem o snapshotId; os valores são só códigos fixos', async () => {
    const cenarios = [
      async () => { const c = criarControle(criarSpawn({ lanca: erroSensivel('ENOENT') }).spawn); const d = await desfecho(c.lancador.lancar(SPEC())); return { c, erro: d.erro }; },
      async () => { const filho = criarFilho({ pid: 0 }); const c = criarControle(criarSpawn({ filho }).spawn); const p = c.lancador.lancar(SPEC()); filho.emitir('spawn'); filho.emitir('error', erroSensivel('EPIPE')); const d = await desfecho(p); return { c, erro: d.erro }; },
      async () => { const { controle, filho } = await lancado({ observador: criarObservador(erroSensivel('EPERM')) }); filho.killLanca = erroSensivel('EPERM'); await controle.sistema.enviarSinal(PID, 'SIGTERM'); await desfecho(controle.sistema.grupoVivo(PID)); return { c: controle, erro: null }; },
    ];
    for (const montar of cenarios) {
      const { resultado: { c, erro }, chamadas } = await comConsoleEspiado(montar);
      semMarcadores(c.situacao(), 'situacao');
      semMarcadores(c.registroDeRecuperacao(), 'registro');
      if (erro) semMarcadores(textoPublico(erro), 'rejeição');
      semMarcadores(chamadas.join('\n'), 'console');
      assert.match(c.situacao().operacaoId, OPACO);
      const { causa } = c.situacao();
      assert.ok(causa === null || /^[A-Z][A-Z0-9_]{1,30}$/.test(causa));
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-08
describe('[CTR-08] compatibilidade com o supervisor e o serviço do dump REAIS: o controlador não transforma diagnóstico em autorização', () => {
  function supervisaoComControle({ observador = criarObservador(false), imediatos = [], scripted = null, aoKill = null, pid = PID } = {}) {
    const { criarProcessoDoDump } = exigirModulo('src/services/imagem-backup-pgdump.service');
    const filho = criarFilho({ pid });
    if (aoKill) filho.aoKill = (sinal) => aoKill(filho, sinal);
    const s = criarSpawn({ filho, aoLancar: (f) => { f.emitir('spawn'); if (scripted) scripted(f); } });
    const controle = criarControle(s.spawn, observador);
    const prazos = [];
    const temporizador = {
      prazo(ms) { const d = {}; d.promessa = new Promise((r) => { d.resolver = r; }); if (imediatos.includes(ms)) d.resolver(); prazos.push({ ms }); return { promessa: d.promessa, cancelar() {} }; },
      intervalo: () => Promise.resolve(),
    };
    const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };
    const contexto = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: null });
    const dump = {
      alvo: { executavel: '/usr/lib/postgresql/16/bin/pg_dump', host: HOST, porta: 5432, usuario: USUARIO, arquivoDeSenha: SENHA_ARQUIVO, bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
      destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump-20261023.pgdump' },
      lancador: controle.lancador,
      sistema: controle.sistema,
      arquivos: { async criarExclusivo() { return { descritor: DESCRITOR, fechar() {} }; } },
      temporizador,
      prazos: { ...PRAZOS },
    };
    return { descricao: criarProcessoDoDump({ contexto, dump }), controle, filho, observador };
  }
  const supervisionar = (descricao) => exigirModulo('src/services/imagem-backup-supervisor.service').supervisionar(descricao);

  teste('CTR-08 — as TRÊS confirmações juntas (exit, close, grupo observado vazio) liberam: saída 0, nenhum sinal, `process.kill` nunca chamado', async () => {
    const m = supervisaoComControle({ scripted: (f) => { f.emitir('exit', 0, null); f.emitir('close', 0, null); } });
    const { resultado: r, chamadas } = await semProcessKill(() => supervisionar(m.descricao));
    assert.equal(r.saida, 0);
    assert.equal(r.liberarTravaPermitido, true);
    assert.deepEqual(m.filho.sinais, []);
    assert.deepEqual(chamadas, []);
    assert.deepEqual(m.observador.chamadas, [PID]);
  });

  for (const [rotulo, observador, esperado] of [
    ['grupo ainda povoado (descendentes)', criarObservador(true), 'DESCENDENTES_ATIVOS'],
    ['observador devolve resposta desconhecida', criarObservador(undefined), 'GRUPO_NAO_CONFIRMADO'],
    ['observador lança', criarObservador(erroSensivel('EPERM')), 'GRUPO_NAO_CONFIRMADO'],
  ]) {
    teste(`CTR-08b (${rotulo}) — exit e close OK mas SEM grupo vazio comprovado: saída 11, trava não liberável, nenhum sinal`, async () => {
      const m = supervisaoComControle({ observador, scripted: (f) => { f.emitir('exit', 0, null); f.emitir('close', 0, null); } });
      const r = await supervisionar(m.descricao);
      assert.equal(r.saida, 11);
      assert.equal(r.liberarTravaPermitido, false);
      assert.ok(r.motivos.includes(esperado));
      assert.deepEqual(m.filho.sinais, []);
      semMarcadores(r, 'resultado');
    });
  }

  teste('CTR-08c — só `exit` (fluxos nunca fecham) e prazo vencido: saída 11, nenhum sinal (o término foi confirmado); só `close` (o término nunca chega): SIGTERM e SIGKILL ao filho CAPTURADO e ainda saída 11', async () => {
    const soExit = supervisaoComControle({ imediatos: [PRAZOS.totalMs], scripted: (f) => f.emitir('exit', 0, null) });
    const r1 = await supervisionar(soExit.descricao);
    assert.equal(r1.saida, 11);
    assert.equal(r1.liberarTravaPermitido, false);
    assert.deepEqual(soExit.filho.sinais, []);
    const soClose = supervisaoComControle({ imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], scripted: (f) => f.emitir('close', 0, null) });
    const { resultado: r2, chamadas } = await semProcessKill(() => supervisionar(soClose.descricao));
    assert.equal(r2.saida, 11);
    assert.equal(r2.liberarTravaPermitido, false);
    assert.deepEqual(soClose.filho.sinais, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(chamadas, []);
  });

  teste('CTR-08d — prazo esgotado com o filho vivo: SIGTERM e SIGKILL chegam SÓ ao filho da operação (pelo `kill` capturado); quando o SIGKILL leva ao `exit`/`close` e o grupo é observado vazio, a liberação segue o contrato (saída 9, forçado)', async () => {
    const m = supervisaoComControle({ imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs], aoKill: (f, sinal) => { if (sinal === 'SIGKILL') { f.emitir('exit', null, 'SIGKILL'); f.emitir('close', null, 'SIGKILL'); } } });
    const { resultado: r, chamadas } = await semProcessKill(() => supervisionar(m.descricao));
    assert.deepEqual(m.filho.sinais, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(chamadas, []);
    assert.equal(r.saida, 9);
    assert.equal(r.encerramentoForcado, true);
    assert.equal(r.liberarTravaPermitido, true);
  });

  teste('CTR-08e — lançamento inconclusivo pelo supervisor real: INICIO_FALHOU + INICIO_INCONCLUSIVO, trava não liberável, nenhum sinal, observador e filho intocados', async () => {
    const m = supervisaoComControle({ pid: 0 });
    const r = await supervisionar(m.descricao);
    assert.deepEqual([...r.motivos], ['INICIO_FALHOU', 'INICIO_INCONCLUSIVO']);
    assert.equal(r.saida, 1);
    assert.equal(r.liberarTravaPermitido, false);
    assert.deepEqual(m.filho.sinais, []);
    assert.deepEqual(m.observador.chamadas, []);
    assert.equal(m.controle.situacao().estado, 'INCONCLUSIVO');
  });

  teste('CTR-08f — perda de observabilidade (nenhum evento do filho, observador falhando) com prazos vencidos: nada vira término; saída 11, trava não liberável', async () => {
    const m = supervisaoComControle({ observador: criarObservador(erroSensivel('EPERM')), imediatos: [PRAZOS.totalMs, PRAZOS.cortesiaMs] });
    const r = await supervisionar(m.descricao);
    assert.equal(r.saida, 11);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('SAIDA_INDEFINIDA'));
    assert.ok(r.motivos.includes('GRUPO_NAO_CONFIRMADO'));
    assert.equal(m.controle.registroDeRecuperacao().autorizaLiberarTrava, false);
    semMarcadores(r, 'resultado');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CTR-09
describe('[CTR-09] limites de comprovação e pendências PRÉ-OPERACIONAIS (registradas, NÃO executadas)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('CTR-09a — reutilização de PID e PGID: a semântica real de `ChildProcess.kill` e a janela de reutilização após o término só se comprovam com processos reais em Linux e macOS (a documentação do Node.js reconhece o risco depois do término)', 'depende de sistema operacional real');
  todo('CTR-09b — identidade do grupo depois do término do líder e atomicidade de qualquer sinal a grupo: nenhuma API do Node a oferece; a contenção de descendentes exige cgroup v2/systemd (`cgroup.kill` aplica SIGKILL à árvore; o encerramento gracioso exige mecanismo complementar)', 'decisão arquitetural (alternativa B)');
  todo('CTR-09c — contenção em Linux (cgroup v2, permissões, delegação, kernel mínimo) e descendentes que escapam por `setsid`', 'depende de Linux real');
  todo('CTR-09d — pidfd nativo: adiado; nenhuma dependência nova autorizada', 'adiado (alternativa C)');
  todo('CTR-09e — stdout por pipe (contrapressão, tamanho, hash, arquivo parcial e confirmação de fechamento) em incremento separado; hoje o contrato por descritor segue (D9)', 'incremento próprio');
  todo('CTR-09f — recuperação após a morte do orquestrador: o handle se perde e o filho vira órfão sem observador; procedimento operacional manual que NÃO trate linha de comando e horário de início como prova suficiente para sinalizar', 'decisão operacional');
  todo('CTR-09g — persistência do registro de recuperação (junto da trava, sem snapshotId, sem credenciais, sem ambiente) e alerta ao operador; o snapshotId do PostgreSQL não é identificador reutilizável depois da morte da transação', 'especificação futura');
  todo('CTR-09h — observador real de grupo (`/proc` no Linux, alternativa no macOS): varredura que falha para o lado seguro e não é prova de identidade imutável', 'depende de sistema operacional real');
});
