'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const diarioModulo = require('./imagem-backup-diario-execucao.service');
const portas = require('./imagem-backup-portas-sistema.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6): LANÇADOR DA SENTINELA DO POSTMASTER (lado do runner). Faz pelo PostgreSQL efêmero o que o lançador de sentinelas faz pelos clientes: o runner NÃO cria mais o postmaster; ele pede a um processo independente (a sentinela do postmaster) que o crie,
 * e passa a só OBSERVAR (pid, `postmaster.pid`, `ps`, conexão). O runner nunca sinaliza o postmaster nem a sentinela pelo sistema operacional: o encerramento é um PEDIDO pelo canal restrito (PARAR com SIGINT) e o resultado vem do DIÁRIO da sentinela, não do que o runner acha.
 *
 * Ordem do lançamento: valida o contrato; grava duravelmente a INTENÇÃO (papel `postgres`); lança a sentinela com o `child_process.spawn` real; grava SENTINELA_LANCADA; espera a sentinela informar a identidade do postmaster (mensagem CLIENTE, conferida contra o diário). Sem diário durável nada é lançado.
 * O ambiente, o PGDATA, o socket, a porta e a descrição de saída (log do servidor) são os que o runner entrega, sem alteração: o postmaster herda os fluxos da sentinela e a sentinela, os do runner.
 *
 * `encerrar()` (idempotente) pede a parada e espera a SAÍDA da sentinela, que só sai depois do término do postmaster e da conferência do grupo. Resultados (mesmo vocabulário do encerramento antigo, mais o anormal): ENCERRADA, ENCERRADA_ANORMAL (SIGQUIT usado ou saída fora do normal; comprovada, mas nunca "limpa"), IDENTIDADE_INCERTA,
 * ENCERRAMENTO_INCERTO (resistente, falha de sinalização, descendentes, grupo não confirmado, diário incompleto, sentinela sem resposta ou perdida). Só ENCERRADA vale como encerramento seguro; os outros preservam a área e as travas.
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const caminhoAbsoluto = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const chavesExatas = (o, esperadas) => { const k = Reflect.ownKeys(o); return k.length === esperadas.length && k.every((c) => typeof c === 'string' && esperadas.includes(c)); };
const inteiro = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;

function erro(codigo, extra = {}) {
  const falha = new Error('lançador da sentinela do postmaster');
  falha.code = codigo;
  return Object.assign(falha, extra);
}
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do lançador do postmaster inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const exigir = (condicao) => { if (!condicao) throw configuracaoInvalida(); };

const PRAZOS_PADRAO = Object.freeze({ sigintMs: 30000, sigquitMs: 15000, esperaClientesMs: 30000, passoClientesMs: 500 });

function criarSupervisorDePostmaster(opcoes) {
  exigir(ehObjeto(opcoes));
  const { raiz, tentativaId, diario, scriptDoPostmaster } = opcoes;
  const execPath = opcoes.execPath === undefined ? process.execPath : opcoes.execPath;
  const temporizador = opcoes.temporizador === undefined ? portas.temporizadorReal : opcoes.temporizador;
  const prazos = opcoes.prazos === undefined ? PRAZOS_PADRAO : opcoes.prazos;
  const grupo = opcoes.grupo === undefined ? { tentativas: 25, intervaloMs: 200 } : opcoes.grupo;
  const identificacao = opcoes.identificacao === undefined ? { tentativas: 5, intervaloMs: 500 } : opcoes.identificacao;
  const prazoIdentidadeMs = opcoes.prazoIdentidadeMs === undefined ? 30000 : opcoes.prazoIdentidadeMs;
  const margemMs = opcoes.margemMs === undefined ? 10000 : opcoes.margemMs;
  exigir(caminhoAbsoluto(raiz) && typeof tentativaId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(tentativaId) && ehObjeto(diario) && ehFuncao(diario.registrar) && caminhoAbsoluto(scriptDoPostmaster) && caminhoAbsoluto(execPath));
  exigir(ehObjeto(temporizador) && ehFuncao(temporizador.prazo));
  exigir(ehObjeto(prazos) && chavesExatas(prazos, ['sigintMs', 'sigquitMs', 'esperaClientesMs', 'passoClientesMs']) && Object.values(prazos).every((v) => inteiro(v, 600000)));
  exigir(ehObjeto(grupo) && chavesExatas(grupo, ['tentativas', 'intervaloMs']) && ehObjeto(identificacao) && chavesExatas(identificacao, ['tentativas', 'intervaloMs']));
  exigir(inteiro(prazoIdentidadeMs, 600000) && inteiro(margemMs, 600000));
  const spawnDoNode = opcoes.spawnDoNode;
  exigir(spawnDoNode === undefined || ehFuncao(spawnDoNode));

  let entrada = null; // { lancamentoId, token, filho, saiu, codigo, sinal, saidaP, postmasterPid }
  let suspenso = false;
  let encerramento = null;

  const escritor = () => (entrada === null ? null : `sentinela-${entrada.lancamentoId}`);
  function lerDoDiario() {
    try {
      const e = diarioModulo.lerTentativa({ raiz, tentativaId }).escritores[escritor()];
      return e !== undefined && e.estado === 'INTEGRO' ? e.eventos : null;
    } catch {
      return null;
    }
  }

  function enviar(mensagem) {
    const f = entrada.filho;
    if (f.connected !== true || !ehFuncao(f.send)) return false;
    try { f.send({ canal: entrada.lancamentoId, token: entrada.token, ...mensagem }); return true; } catch { return false; }
  }

  function validarPedido(p) {
    exigir(ehObjeto(p) && chavesExatas(p, ['comando', 'argumentos', 'env', 'stdio', 'esperado']));
    exigir(caminhoAbsoluto(p.comando) && Array.isArray(p.argumentos) && p.argumentos.length <= 256 && p.argumentos.every((a) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')));
    exigir(ehObjeto(p.env) && Object.keys(p.env).length <= 32 && Object.values(p.env).every((v) => typeof v === 'string'));
    exigir(Array.isArray(p.stdio) && p.stdio.length === 3 && p.stdio.every((s) => s === 'ignore' || (Number.isSafeInteger(s) && s >= 3)));
    exigir(ehObjeto(p.esperado) && chavesExatas(p.esperado, ['pgdata', 'porta', 'socket']) && caminhoAbsoluto(p.esperado.pgdata) && caminhoAbsoluto(p.esperado.socket) && inteiro(p.esperado.porta, 65535));
  }

  /** Lança a sentinela do postmaster. Resolve com a identidade confirmada pela sentinela; rejeita (sem afirmar nada sobre o postmaster) se ela não nasceu ou não confirmou. A finalização do runner chama `encerrar()` em qualquer caso. */
  async function iniciar(pedido) {
    validarPedido(pedido);
    if (suspenso) throw erro('LANCAMENTO_SUSPENSO');
    if (entrada !== null) throw erro('POSTMASTER_JA_INICIADO');
    const lancamentoId = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    diario.registrar('INTENCAO_LANCAMENTO', { lancamentoId, papel: 'postgres', executavel: path.basename(pedido.comando), nArgs: pedido.argumentos.length, argsSha256: crypto.createHash('sha256').update(JSON.stringify(pedido.argumentos)).digest('hex') });
    const configuracao = Buffer.from(JSON.stringify({
      v: 1, raiz, tentativaId, lancamentoId, token, comando: pedido.comando, argumentos: pedido.argumentos, prazos, grupo, identificacao, esperado: pedido.esperado,
    }), 'utf8').toString('base64');
    const lancar = spawnDoNode === undefined ? require('node:child_process').spawn : spawnDoNode;
    let filho;
    try {
      filho = lancar(execPath, [scriptDoPostmaster, configuracao], { env: { ...pedido.env }, shell: false, detached: true, stdio: [...pedido.stdio, 'ipc'] });
    } catch (falha) {
      try { diario.registrar('LANCAMENTO_NAO_INICIADO', { lancamentoId, codigo: 'SPAWN_LANCOU' }); } catch { /* sem prova gravada, a reconciliação trata como sem identidade */ }
      throw falha;
    }
    const e = { lancamentoId, token, filho, saiu: false, codigo: null, sinal: null, saidaP: null, postmasterPid: null, identidadeP: null };
    e.saidaP = new Promise((resolver) => {
      filho.on('exit', (codigo, sinal) => { e.saiu = true; e.codigo = Number.isInteger(codigo) ? codigo : null; e.sinal = typeof sinal === 'string' ? sinal : null; resolver(true); });
    });
    let resolverIdentidade;
    e.identidadeP = new Promise((r) => { resolverIdentidade = r; });
    filho.on('message', (m) => {
      if (ehObjeto(m) && m.canal === lancamentoId && m.t === 'CLIENTE' && Number.isSafeInteger(m.clientePid) && m.clientePid > 1) { e.postmasterPid = m.clientePid; resolverIdentidade(true); }
    });
    filho.on('error', () => {
      if (Number.isSafeInteger(filho.pid)) return;
      try { diario.registrar('LANCAMENTO_NAO_INICIADO', { lancamentoId, codigo: 'SPAWN_ERRO' }); } catch { /* idem */ }
    });
    if (!Number.isSafeInteger(filho.pid) || filho.pid <= 1) throw erro('POSTMASTER_NAO_INICIOU');
    entrada = e;
    try {
      diario.registrar('SENTINELA_LANCADA', { lancamentoId, sentinelaPid: filho.pid });
    } catch (falha) {
      enviar({ t: 'PARAR', sinal: 'SIGINT' });
      throw falha;
    }
    // o `kill` do handle fala com a sentinela pelo canal restrito (só o pedido de parada); o runner nunca sinaliza a sentinela pelo sistema operacional
    Object.defineProperty(filho, 'kill', { value: (sinal) => (sinal === 'SIGINT' ? enviar({ t: 'PARAR', sinal: 'SIGINT' }) : false), writable: false, configurable: true, enumerable: false });

    const prazo = temporizador.prazo(prazoIdentidadeMs);
    const r = await Promise.race([e.identidadeP.then(() => 'identidade'), e.saidaP.then(() => 'saiu'), prazo.promessa.then(() => 'prazo')]);
    prazo.cancelar();
    if (r === 'identidade') return Object.freeze({ lancamentoId, sentinelaPid: filho.pid, postmasterPid: e.postmasterPid });
    // a mensagem pode ter se perdido: o diário (identidade durável) vale como segunda fonte, nunca como autoridade para sinal
    const eventos = lerDoDiario();
    const lancado = eventos === null ? undefined : eventos.find((x) => x.k === 'CLIENTE_LANCADO');
    if (lancado !== undefined && Number.isSafeInteger(lancado.d.clientePid)) { e.postmasterPid = lancado.d.clientePid; return Object.freeze({ lancamentoId, sentinelaPid: filho.pid, postmasterPid: e.postmasterPid }); }
    throw erro(r === 'saiu' ? 'POSTMASTER_NAO_INICIOU' : 'POSTMASTER_IDENTIDADE_NAO_CONFIRMADA');
  }

  function esperaTotalMs() {
    return prazos.esperaClientesMs + prazos.sigintMs + prazos.sigquitMs + 2 * identificacao.tentativas * identificacao.intervaloMs + grupo.tentativas * grupo.intervaloMs + margemMs;
  }

  /** Resultado do encerramento a partir do diário da sentinela (a fonte do que ela de fato fez e observou), no vocabulário do runner. */
  function resultadoDoDiario() {
    const eventos = lerDoDiario();
    if (eventos === null) return { resultado: 'ENCERRAMENTO_INCERTO', sinais: [], falhas: ['REGISTRO_DA_SENTINELA_ILEGIVEL'] };
    const sinais = eventos.filter((x) => x.k === 'SINAL_ENVIADO').map((x) => x.d.sinal);
    const fim = eventos.filter((x) => x.k === 'SENTINELA_FIM').at(-1);
    if (fim === undefined) return { resultado: 'ENCERRAMENTO_INCERTO', sinais, falhas: ['AUTORIDADE_PERDIDA'] };
    const mapa = { CONCLUIDO: 'ENCERRADA', ENCERRADO_ANORMAL: 'ENCERRADA_ANORMAL', IDENTIDADE_INCERTA: 'IDENTIDADE_INCERTA' };
    const resultado = mapa[fim.d.resultado] ?? 'ENCERRAMENTO_INCERTO';
    return { resultado, sinais, falhas: resultado === 'ENCERRAMENTO_INCERTO' ? [fim.d.resultado] : [] };
  }

  async function encerrarDeVerdade() {
    suspenso = true;
    if (entrada === null) return Object.freeze({ resultado: 'ENCERRADA', sinais: Object.freeze([]), falhas: Object.freeze([]), semInstancia: true });
    const falhas = [];
    if (!entrada.saiu && !enviar({ t: 'PARAR', sinal: 'SIGINT' })) falhas.push('CANAL_INDISPONIVEL');
    if (!entrada.saiu) {
      const prazo = temporizador.prazo(esperaTotalMs());
      const r = await Promise.race([entrada.saidaP.then(() => 'saiu'), prazo.promessa.then(() => 'prazo')]);
      prazo.cancelar();
      if (r !== 'saiu') return Object.freeze({ resultado: 'ENCERRAMENTO_INCERTO', sinais: Object.freeze([]), falhas: Object.freeze([...falhas, 'SENTINELA_NAO_RESPONDEU']) });
    }
    const d = resultadoDoDiario();
    return Object.freeze({ resultado: d.resultado, sinais: Object.freeze(d.sinais), falhas: Object.freeze([...falhas, ...d.falhas]) });
  }

  return Object.freeze({
    iniciar,
    encerrar() { if (encerramento === null) encerramento = encerrarDeVerdade(); return encerramento; },
    suspender() { suspenso = true; },
    jaSaiu: () => entrada !== null && entrada.saiu,
    situacao: () => (entrada === null ? null : Object.freeze({ lancamentoId: entrada.lancamentoId, sentinelaPid: entrada.filho.pid, postmasterPid: entrada.postmasterPid, saiu: entrada.saiu, codigo: entrada.codigo, sinal: entrada.sinal })),
    saida: () => (entrada === null ? Promise.resolve(true) : entrada.saidaP),
  });
}

module.exports = { criarSupervisorDePostmaster, PRAZOS_PADRAO };
