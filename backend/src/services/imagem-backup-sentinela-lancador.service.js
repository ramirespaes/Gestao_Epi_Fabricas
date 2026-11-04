'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const diarioModulo = require('./imagem-backup-diario-execucao.service');
const portas = require('./imagem-backup-portas-sistema.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): LANÇADOR DE SENTINELAS (lado do runner). Faz o papel do `spawn` e do `observarGrupo` que a composição de produção já aceita por injeção (`portas.spawn`, `portas.observarGrupo`), de modo que os lançadores do pg_dump, do pg_restore e da
 * verificação estrutural, o controle de processo e o supervisor continuem EXATAMENTE como são. O que o runner recebe no lugar do filho é o ChildProcess REAL da SENTINELA (processo independente, com os MESMOS fluxos: stdout/stderr em pipe, descritor do dump, `close`), cujo `kill` fala com a sentinela
 * pelo canal IPC restrito: SIGINT/SIGTERM viram PARAR e SIGKILL vira ESCALAR (sempre aplicados ao CLIENTE, por quem o lançou); o runner nunca sinaliza a sentinela pelo sistema operacional.
 *
 * Ordem do lançamento: valida o contrato; grava duravelmente a INTENÇÃO; lança a sentinela com o `child_process.spawn` real; grava SENTINELA_LANCADA. Sem diário durável nada é lançado; `spawn` que lança é falha de início comprovada (LANCAMENTO_NAO_INICIADO). A identidade do CLIENTE quem grava é a sentinela. Os argumentos
 * do cliente viajam só para a sentinela (configuração em base64 no argv, sem segredos: o ambiente do cliente vai no `env`); o diário recebe apenas a contagem e o hash dos argumentos.
 *
 * `observarGrupo(pgid)` responde pelo diário da sentinela (GRUPO_VERIFICADO), não por consulta de PID: sentinela viva = grupo povoado; saída sem registro de grupo confirmado = LANÇA (nunca "vazio"). `suspender()` impede novos lançamentos. `encerrarClientes()` pede a parada de todos os clientes vivos
 * (PARAR, depois ESCALAR) e só afirma ENCERRADOS com a SAÍDA observada e o grupo comprovadamente vazio no diário.
 * O spawn devolvido é GENUÍNO (reconhecido por `ehSpawnReal`) só quando usa o `child_process.spawn` real interno; com `spawnDoNode` injetado (testes) nunca é.
 */

const spawnsGenuinos = new WeakSet();
const ehSpawnDeSentinelaGenuino = (fn) => typeof fn === 'function' && spawnsGenuinos.has(fn);

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const PAPEL = /^[a-z][a-z0-9_]{1,31}$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const caminhoAbsoluto = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const chavesExatas = (o, esperadas) => { const k = Reflect.ownKeys(o); return k.length === esperadas.length && k.every((c) => typeof c === 'string' && esperadas.includes(c)); };
const pidSeguro = (v) => Number.isSafeInteger(v) && v > 1;

function erro(codigo, extra = {}) {
  const falha = new Error('lançador de sentinelas');
  falha.code = codigo;
  return Object.assign(falha, extra);
}
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do lançador de sentinelas inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const exigir = (condicao) => { if (!condicao) throw configuracaoInvalida(); };

function papelDe(comando, args) {
  const nome = path.basename(comando).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const base = PAPEL.test(nome) ? nome : 'externo';
  return base === 'pg_restore' && args.includes('--list') ? 'pg_restore_list' : base;
}

function validarEntrada(comando, args, op) {
  exigir(caminhoAbsoluto(comando) && Array.isArray(args) && args.length <= 256 && args.every((a) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')));
  exigir(ehObjeto(op) && chavesExatas(op, ['env', 'shell', 'detached', 'stdio']) && op.shell === false && op.detached === true);
  exigir(ehObjeto(op.env) && Object.keys(op.env).length <= 32 && Object.values(op.env).every((v) => typeof v === 'string'));
  exigir(Array.isArray(op.stdio) && op.stdio.length === 3 && op.stdio.every((s) => s === 'ignore' || s === 'pipe' || (Number.isSafeInteger(s) && s >= 3)));
}

function criarSupervisorDeProcessos(opcoes) {
  exigir(ehObjeto(opcoes));
  const { raiz, tentativaId, diario, scriptDaSentinela } = opcoes;
  const execPath = opcoes.execPath === undefined ? process.execPath : opcoes.execPath;
  const temporizador = opcoes.temporizador === undefined ? portas.temporizadorReal : opcoes.temporizador;
  const cortesiaMs = opcoes.cortesiaMs === undefined ? 5000 : opcoes.cortesiaMs;
  const esperaPosKillMs = opcoes.esperaPosKillMs === undefined ? 5000 : opcoes.esperaPosKillMs;
  const grupo = opcoes.grupo === undefined ? { tentativas: 25, intervaloMs: 200 } : opcoes.grupo;
  exigir(caminhoAbsoluto(raiz) && typeof tentativaId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(tentativaId) && ehObjeto(diario) && ehFuncao(diario.registrar) && caminhoAbsoluto(scriptDaSentinela) && caminhoAbsoluto(execPath));
  exigir(ehObjeto(temporizador) && ehFuncao(temporizador.prazo) && Number.isSafeInteger(cortesiaMs) && cortesiaMs > 0 && Number.isSafeInteger(esperaPosKillMs) && esperaPosKillMs > 0);
  exigir(ehObjeto(grupo) && chavesExatas(grupo, ['tentativas', 'intervaloMs']));
  const spawnDoNode = opcoes.spawnDoNode;
  exigir(spawnDoNode === undefined || ehFuncao(spawnDoNode));

  const entradas = new Map(); // pid da sentinela -> entrada
  let suspenso = false;

  function grupoVazioNoDiario(entrada) {
    try {
      const leitura = diarioModulo.lerTentativa({ raiz, tentativaId });
      const escritor = leitura.escritores[`sentinela-${entrada.lancamentoId}`];
      if (escritor === undefined || escritor.estado !== 'INTEGRO') return null;
      const registro = escritor.eventos.filter((e) => e.k === 'GRUPO_VERIFICADO').at(-1);
      return registro === undefined ? null : registro.d.vazio;
    } catch {
      return null;
    }
  }

  function enviar(entrada, mensagem) {
    const f = entrada.filho;
    if (f.connected !== true || !ehFuncao(f.send)) return false;
    try { f.send({ canal: entrada.lancamentoId, token: entrada.token, ...mensagem }); return true; } catch { return false; }
  }

  function spawn(comando, args, op) {
    validarEntrada(comando, args, op);
    if (suspenso) throw erro('LANCAMENTO_SUSPENSO');
    const lancamentoId = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    // INTENÇÃO durável ANTES de qualquer efeito: se não for sincronizada, nada é lançado
    diario.registrar('INTENCAO_LANCAMENTO', { lancamentoId, papel: papelDe(comando, args), executavel: path.basename(comando), nArgs: args.length, argsSha256: crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex') });
    const configuracao = Buffer.from(JSON.stringify({
      v: 1, raiz, tentativaId, lancamentoId, token, comando, argumentos: args, cortesiaMs, esperaPosKillMs, grupo: { tentativas: grupo.tentativas, intervaloMs: grupo.intervaloMs },
    }), 'utf8').toString('base64');
    const lancar = spawnDoNode === undefined ? require('node:child_process').spawn : spawnDoNode;
    let filho;
    try {
      filho = lancar(execPath, [scriptDaSentinela, configuracao], { env: { ...op.env }, shell: false, detached: true, stdio: [...op.stdio, 'ipc'] });
    } catch (falha) {
      try { diario.registrar('LANCAMENTO_NAO_INICIADO', { lancamentoId, codigo: 'SPAWN_LANCOU' }); } catch { /* sem prova gravada, a reconciliação trata como sem identidade */ }
      throw falha;
    }
    const entrada = { lancamentoId, token, filho, saiu: false, codigo: null, sinal: null, saidaP: null, pedidoDeParada: false };
    entrada.saidaP = new Promise((resolver) => {
      filho.on('exit', (codigo, sinal) => { entrada.saiu = true; entrada.codigo = Number.isInteger(codigo) ? codigo : null; entrada.sinal = typeof sinal === 'string' ? sinal : null; resolver(true); });
    });
    // mensagens da sentinela são informativas: o término e o grupo vêm do evento de saída e do diário
    filho.on('message', () => {});
    // sem pid: `error` assíncrono é a única prova de que a sentinela não nasceu; `error` com pid não prova nada (e o listener evita que o Node o trate como exceção não capturada)
    filho.on('error', () => {
      if (pidSeguro(filho.pid)) return;
      try { diario.registrar('LANCAMENTO_NAO_INICIADO', { lancamentoId, codigo: 'SPAWN_ERRO' }); } catch { /* sem prova gravada, a reconciliação trata como sem identidade */ }
    });
    if (!pidSeguro(filho.pid)) return filho;
    entradas.set(filho.pid, entrada);
    try {
      diario.registrar('SENTINELA_LANCADA', { lancamentoId, sentinelaPid: filho.pid });
    } catch (falha) {
      // a sentinela já existe e o runner não conseguiu registrá-la: pede a parada do cliente pelo canal (a sentinela registra o que fizer) e propaga a falha
      enviar(entrada, { t: 'PARAR', sinal: 'SIGTERM' });
      throw falha;
    }
    // O `kill` do handle fala com a sentinela pelo canal restrito; função própria (lida uma vez pelo controle de processo) que não depende do receiver
    const matar = (sinal) => {
      if (sinal === 'SIGKILL') return enviar(entrada, { t: 'ESCALAR' });
      if (sinal === 'SIGINT' || sinal === 'SIGTERM') return enviar(entrada, { t: 'PARAR', sinal });
      return false;
    };
    Object.defineProperty(filho, 'kill', { value: matar, writable: false, configurable: true, enumerable: false });
    return filho;
  }

  async function observarGrupo(pgid) {
    const entrada = pidSeguro(pgid) ? entradas.get(pgid) : undefined;
    if (entrada === undefined) throw erro('GRUPO_NAO_CONFIRMADO');
    if (!entrada.saiu) return true;
    const vazio = grupoVazioNoDiario(entrada);
    if (vazio === true) return false;
    if (vazio === false) return true;
    throw erro('GRUPO_NAO_CONFIRMADO');
  }

  async function aguardar(entrada, ms) {
    if (entrada.saiu) return true;
    const prazo = temporizador.prazo(ms);
    const r = await Promise.race([entrada.saidaP.then(() => true), prazo.promessa.then(() => false)]);
    prazo.cancelar();
    return r;
  }

  async function encerrarUm(entrada, { cortesia, espera }) {
    if (!entrada.saiu) {
      enviar(entrada, { t: 'PARAR', sinal: 'SIGTERM' });
      if (!(await aguardar(entrada, cortesia))) {
        enviar(entrada, { t: 'ESCALAR' });
        await aguardar(entrada, espera);
      }
    }
    const vazio = entrada.saiu ? grupoVazioNoDiario(entrada) : null;
    return Object.freeze({ lancamentoId: entrada.lancamentoId, sentinelaPid: entrada.filho.pid, encerrado: entrada.saiu, codigo: entrada.codigo, sinal: entrada.sinal, grupoVazio: vazio });
  }

  async function encerrarClientes({ cortesiaMs: c = cortesiaMs, esperaMs = esperaPosKillMs } = {}) {
    const todas = [...entradas.values()];
    if (todas.length === 0) return Object.freeze({ resultado: 'NENHUM', clientes: Object.freeze([]) });
    const clientes = await Promise.all(todas.map((e) => encerrarUm(e, { cortesia: c, espera: esperaMs })));
    const comprovado = clientes.every((x) => x.encerrado === true && x.grupoVazio === true);
    return Object.freeze({ resultado: comprovado ? 'ENCERRADOS' : 'NAO_COMPROVADO', clientes: Object.freeze(clientes) });
  }

  const spawnRetornado = spawn;
  if (spawnDoNode === undefined) spawnsGenuinos.add(spawnRetornado);

  return Object.freeze({
    spawn: spawnRetornado,
    observarGrupo,
    suspender() { suspenso = true; },
    encerrarClientes,
    situacao: () => Object.freeze([...entradas.values()].map((e) => Object.freeze({ lancamentoId: e.lancamentoId, sentinelaPid: e.filho.pid, saiu: e.saiu, codigo: e.codigo, sinal: e.sinal }))),
  });
}

module.exports = { criarSupervisorDeProcessos, ehSpawnDeSentinelaGenuino };
