'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * PARADA POR SINAL (Biblioteca de Imagens, P-ORF-01, G7): `criarParadaPorSinal` transforma SIGINT e SIGTERM num PEDIDO de parada que o trabalho consulta entre uma unidade e
 * outra, em vez de matar o processo no meio. O manipulador só registra o sinal e avisa (`aoReceber(sinal, ordem)`): nunca encerra o processo, nunca envia sinal, nunca toca em
 * arquivo ou banco, e um erro do aviso nunca escapa dele. `encerrar()` devolve ao Node o comportamento padrão. `saidaDoSinal` dá o código de saída de shell (128 + número).
 *   criarParadaPorSinal({ processo = process, sinais = ['SIGINT', 'SIGTERM'], aoReceber, armado = true }) -> { deveParar(), sinal(), armar(), encerrar() }    (objeto congelado)
 *   O manipulador só deve existir enquanto há o que proteger: com `armado: false` nada é instalado até `armar()` (idempotente) e, até lá, o Node mantém o comportamento padrão;
 *   `encerrar()` é definitivo (depois dele `armar()` não instala mais).
 *   saidaDoSinal(sinal) -> 128 + número do sinal (SIGINT 130, SIGTERM 143); sinal desconhecido é TypeError.
 * Os testes com PROCESSO REAL só enviam sinal ao processo filho que o próprio teste iniciou (descartável, sem acesso a banco, a imagem ou a trava alguma).
 */

const UTIL = () => exigirModulo('src/utils/parada-por-sinal');
const CAMINHO_DO_MODULO = path.join(__dirname, '..', '..', 'src', 'utils', 'parada-por-sinal');

/** Processo falso: emissor de eventos que também REGISTRA qualquer tentativa de encerrar, abortar ou sinalizar. */
function processoFalso() {
  const processo = new EventEmitter();
  const chamadas = [];
  for (const nome of ['exit', 'kill', 'abort', 'reallyExit']) processo[nome] = (...argumentos) => { chamadas.push([nome, ...argumentos]); };
  return { processo, chamadas };
}

describe('[PAR] o pedido de parada (processo falso, sem sinal real)', () => {
  test('PAR-01 — por padrão ouve SÓ SIGINT e SIGTERM; `deveParar()` é falso até o primeiro sinal; o primeiro sinal vence; o aviso recebe (sinal, ordem); o objeto é congelado', () => {
    const { criarParadaPorSinal } = UTIL();
    const { processo } = processoFalso();
    const avisos = [];
    const parada = criarParadaPorSinal({ processo, aoReceber: (sinal, ordem) => avisos.push([sinal, ordem]) });
    assert.equal(Object.isFrozen(parada), true);
    assert.deepEqual(Object.keys(parada).sort(), ['armar', 'deveParar', 'encerrar', 'sinal']);
    assert.deepEqual(processo.eventNames().sort(), ['SIGINT', 'SIGTERM']);
    assert.equal(parada.deveParar(), false);
    assert.equal(parada.sinal(), null);
    processo.emit('SIGTERM');
    assert.equal(parada.deveParar(), true);
    assert.equal(parada.sinal(), 'SIGTERM');
    processo.emit('SIGINT');
    assert.equal(parada.sinal(), 'SIGTERM', 'o primeiro sinal vence');
    assert.deepEqual(avisos, [['SIGTERM', 1], ['SIGINT', 2]]);
    parada.encerrar();
  });

  test('PAR-02 — a lista padrão é exatamente SIGINT e SIGTERM (nada de SIGHUP, SIGQUIT nem outro) e é imutável', () => {
    const { SINAIS_PADRAO } = UTIL();
    assert.deepEqual([...SINAIS_PADRAO], ['SIGINT', 'SIGTERM']);
    assert.equal(Object.isFrozen(SINAIS_PADRAO), true);
  });

  test('PAR-03 — `encerrar()` remove os ouvintes (o Node volta ao comportamento padrão), pode ser repetido, e sinal depois dele não muda o estado', () => {
    const { criarParadaPorSinal } = UTIL();
    const { processo } = processoFalso();
    const parada = criarParadaPorSinal({ processo });
    parada.encerrar();
    assert.deepEqual(processo.eventNames(), []);
    assert.doesNotThrow(() => parada.encerrar());
    processo.emit('SIGTERM');
    assert.equal(parada.deveParar(), false);
    assert.equal(parada.sinal(), null);
  });

  test('PAR-04 — o manipulador SÓ registra e avisa: não encerra, não aborta, não envia sinal, não acrescenta ouvinte; vários sinais seguidos mantêm um ouvinte por sinal', () => {
    const { criarParadaPorSinal } = UTIL();
    const { processo, chamadas } = processoFalso();
    const parada = criarParadaPorSinal({ processo, aoReceber: () => {} });
    for (const sinal of ['SIGINT', 'SIGTERM', 'SIGINT', 'SIGTERM']) processo.emit(sinal);
    assert.deepEqual(chamadas, []);
    assert.deepEqual([processo.listenerCount('SIGINT'), processo.listenerCount('SIGTERM')], [1, 1]);
    parada.encerrar();
  });

  test('PAR-05 — um erro lançado pelo aviso NUNCA escapa do manipulador (um erro ali derrubaria o processo e deixaria a trava) e o pedido continua registrado', () => {
    const { criarParadaPorSinal } = UTIL();
    const { processo } = processoFalso();
    let chamadas = 0;
    const parada = criarParadaPorSinal({ processo, aoReceber: () => { chamadas += 1; throw new Error('falha ao avisar'); } });
    assert.doesNotThrow(() => processo.emit('SIGTERM'));
    assert.doesNotThrow(() => processo.emit('SIGINT'));
    assert.equal(parada.deveParar(), true);
    assert.equal(parada.sinal(), 'SIGTERM');
    assert.equal(chamadas, 2);
    parada.encerrar();
  });

  test('PAR-06 — argumentos inválidos são TypeError e NADA é instalado: processo sem `on`/`removeListener`, sinais vazios, repetidos ou desconhecidos, aviso que não é função', () => {
    const { criarParadaPorSinal } = UTIL();
    const { processo } = processoFalso();
    const invalidos = [
      { processo: null }, { processo: {} }, { processo: { on() {} } }, { processo: { removeListener() {} } },
      { sinais: [] }, { sinais: 'SIGTERM' }, { sinais: ['SIGTERM', 'SIGTERM'] }, { sinais: ['SIGFOO'] }, { sinais: [15] }, { sinais: ['constructor'] },
      { aoReceber: 'avisar' }, { aoReceber: null }, { armado: 'sim' }, { armado: null }, { armado: 1 },
    ];
    for (const extra of invalidos) {
      const alvo = { processo, ...extra };
      assert.throws(() => criarParadaPorSinal(alvo), TypeError, JSON.stringify(Object.keys(extra)));
      assert.deepEqual(processo.eventNames(), [], `nada instalado: ${JSON.stringify(Object.keys(extra))}`);
    }
  });

  test('PAR-07 — `saidaDoSinal` é 128 + o número do sinal no sistema (SIGINT 130, SIGTERM 143) e recusa o que não é sinal', () => {
    const { saidaDoSinal } = UTIL();
    assert.equal(saidaDoSinal('SIGINT'), 130);
    assert.equal(saidaDoSinal('SIGTERM'), 143);
    assert.equal(saidaDoSinal('SIGINT'), 128 + os.constants.signals.SIGINT);
    assert.equal(saidaDoSinal('SIGTERM'), 128 + os.constants.signals.SIGTERM);
    for (const invalido of ['SIGFOO', '', 'sigterm', 15, null, undefined, 'constructor']) assert.throws(() => saidaDoSinal(invalido), TypeError, String(invalido));
  });

  test('PAR-12 — `armado: false` não instala NADA até `armar()`: sinal antes dele não é registrado; `armar()` instala só SIGINT e SIGTERM, é idempotente (um ouvinte por sinal) e, depois de `encerrar()`, não instala mais', () => {
    const { criarParadaPorSinal } = UTIL();
    const { processo } = processoFalso();
    const avisos = [];
    const parada = criarParadaPorSinal({ processo, armado: false, aoReceber: (sinal, ordem) => avisos.push([sinal, ordem]) });
    assert.deepEqual(processo.eventNames(), [], 'desarmada: nada instalado');
    processo.emit('SIGTERM');
    assert.deepEqual([parada.deveParar(), parada.sinal(), avisos], [false, null, []], 'sem ouvinte o sinal não é registrado');
    parada.armar();
    parada.armar();
    assert.deepEqual(processo.eventNames().sort(), ['SIGINT', 'SIGTERM']);
    assert.deepEqual([processo.listenerCount('SIGINT'), processo.listenerCount('SIGTERM')], [1, 1], 'armar duas vezes não duplica os ouvintes');
    processo.emit('SIGINT');
    assert.deepEqual([parada.deveParar(), parada.sinal(), avisos], [true, 'SIGINT', [['SIGINT', 1]]]);
    parada.encerrar();
    assert.deepEqual(processo.eventNames(), []);
    parada.armar();
    assert.deepEqual(processo.eventNames(), [], 'depois de encerrar() o armar() não instala mais');

    const nuncaArmada = criarParadaPorSinal({ processo, armado: false });
    nuncaArmada.encerrar();
    nuncaArmada.armar();
    assert.deepEqual(processo.eventNames(), [], 'encerrar() antes de armar() também é definitivo');
  });
});

/** Fonte do processo filho descartável: três "conjuntos" de `duracao` ms; consulta `deveParar()` SÓ antes de cada um; imprime o andamento e sai com o código do sinal. */
const fonteDoFilho = (duracao) => `
const { criarParadaPorSinal, saidaDoSinal } = require(${JSON.stringify(CAMINHO_DO_MODULO)});
const parada = criarParadaPorSinal({ aoReceber: (sinal, ordem) => { process.stderr.write('sinal ' + sinal + ' #' + ordem + '\\n'); } });
const esperar = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });
(async () => {
  process.stdout.write('pronto\\n');
  for (let i = 1; i <= 3; i += 1) {
    if (parada.deveParar()) { process.stdout.write('parou antes do conjunto ' + i + '\\n'); break; }
    process.stdout.write('inicio ' + i + '\\n');
    await esperar(${duracao});
    process.stdout.write('fim ' + i + '\\n');
  }
  parada.encerrar();
  process.exitCode = parada.deveParar() ? saidaDoSinal(parada.sinal()) : 0;
})();
`;

/** Processo filho DESCARTÁVEL deste teste: o único alvo de sinal. O prazo é só rede de segurança do próprio filho (SIGTERM padrão do Node). */
function iniciarFilho(fonte) {
  const filho = spawn(process.execPath, ['-e', fonte], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const saida = { stdout: '', stderr: '' };
  filho.stdout.setEncoding('utf8').on('data', (pedaco) => { saida.stdout += pedaco; });
  filho.stderr.setEncoding('utf8').on('data', (pedaco) => { saida.stderr += pedaco; });
  const termino = new Promise((resolver, rejeitar) => {
    filho.once('error', rejeitar);
    filho.once('close', (codigo, sinal) => resolver({ codigo, sinal, ...saida }));
  });
  return { filho, termino, saida };
}

async function esperarTexto(processo, fluxo, regex, limiteMs = 10000) {
  let terminou = false;
  processo.termino.then(() => { terminou = true; }, () => { terminou = true; });
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (regex.test(processo.saida[fluxo])) return;
    if (terminou) throw new Error(`o processo terminou antes de aparecer ${regex} em ${fluxo}`);
    await new Promise((resolver) => { setTimeout(resolver, 10); });
  }
  throw new Error(`prazo esgotado esperando ${regex} em ${fluxo}`);
}

describe('[PAR] com PROCESSO REAL descartável (o teste só sinaliza o filho que ele mesmo iniciou)', () => {
  test('PAR-08 — SIGTERM no meio de um conjunto: ele TERMINA, o seguinte não começa, o processo sai com 143 (não é morto pelo sinal) e o aviso foi dado uma vez', { timeout: 60000 }, async () => {
    UTIL();
    const p = iniciarFilho(fonteDoFilho(500));
    await esperarTexto(p, 'stdout', /inicio 1\n/);
    p.filho.kill('SIGTERM');
    const r = await p.termino;
    assert.deepEqual([r.codigo, r.sinal], [143, null]);
    assert.equal(r.stdout, 'pronto\ninicio 1\nfim 1\nparou antes do conjunto 2\n');
    assert.equal(r.stderr, 'sinal SIGTERM #1\n');
  });

  test('PAR-09 — SIGINT no meio de um conjunto: o mesmo, com saída 130', { timeout: 60000 }, async () => {
    UTIL();
    const p = iniciarFilho(fonteDoFilho(500));
    await esperarTexto(p, 'stdout', /inicio 1\n/);
    p.filho.kill('SIGINT');
    const r = await p.termino;
    assert.deepEqual([r.codigo, r.sinal], [130, null]);
    assert.equal(r.stdout, 'pronto\ninicio 1\nfim 1\nparou antes do conjunto 2\n');
    assert.equal(r.stderr, 'sinal SIGINT #1\n');
  });

  test('PAR-10 — um SEGUNDO sinal durante a parada não interrompe o conjunto em andamento e não troca o código de saída (o primeiro sinal vence)', { timeout: 60000 }, async () => {
    UTIL();
    const p = iniciarFilho(fonteDoFilho(1500));
    await esperarTexto(p, 'stdout', /inicio 1\n/);
    p.filho.kill('SIGTERM');
    await esperarTexto(p, 'stderr', /sinal SIGTERM #1\n/);
    p.filho.kill('SIGINT');
    await esperarTexto(p, 'stderr', /sinal SIGINT #2\n/);
    const r = await p.termino;
    assert.deepEqual([r.codigo, r.sinal], [143, null]);
    assert.equal(r.stdout, 'pronto\ninicio 1\nfim 1\nparou antes do conjunto 2\n', 'o conjunto em andamento terminou e nenhum outro começou');
    assert.equal(r.stderr, 'sinal SIGTERM #1\nsinal SIGINT #2\n');
  });

  test('PAR-11 — sem pedido nenhum o trabalho vai até o fim e sai com 0; e depois de `encerrar()` o Node volta ao comportamento PADRÃO (o sinal mata o processo, sem manipulador)', { timeout: 60000 }, async () => {
    UTIL();
    const completo = iniciarFilho(fonteDoFilho(50));
    const c = await completo.termino;
    assert.deepEqual([c.codigo, c.sinal], [0, null]);
    assert.equal(c.stdout, 'pronto\ninicio 1\nfim 1\ninicio 2\nfim 2\ninicio 3\nfim 3\n');

    const ocioso = iniciarFilho(`
      const { criarParadaPorSinal } = require(${JSON.stringify(CAMINHO_DO_MODULO)});
      criarParadaPorSinal().encerrar();
      process.stdout.write('ocioso\\n');
      setTimeout(() => {}, 20000);
    `);
    await esperarTexto(ocioso, 'stdout', /ocioso\n/);
    ocioso.filho.kill('SIGTERM');
    const o = await ocioso.termino;
    assert.deepEqual([o.codigo, o.sinal], [null, 'SIGTERM'], 'sem manipulador o Node encerra pelo próprio sinal');
  });

  test('PAR-13 — DESARMADA a parada não absorve sinal: o processo morre pelo próprio sinal, como sempre (um Ctrl-C numa conexão que não responde ainda funciona); depois de `armar()` o mesmo sinal vira pedido de parada e sai com 143', { timeout: 60000 }, async () => {
    UTIL();
    const desarmado = iniciarFilho(`
      const { criarParadaPorSinal } = require(${JSON.stringify(CAMINHO_DO_MODULO)});
      criarParadaPorSinal({ armado: false });
      process.stdout.write('desarmado\\n');
      setTimeout(() => {}, 20000);
    `);
    await esperarTexto(desarmado, 'stdout', /desarmado\n/);
    desarmado.filho.kill('SIGTERM');
    const d = await desarmado.termino;
    assert.deepEqual([d.codigo, d.sinal], [null, 'SIGTERM'], 'antes de armar não há manipulador');

    const armado = iniciarFilho(`
      const { criarParadaPorSinal, saidaDoSinal } = require(${JSON.stringify(CAMINHO_DO_MODULO)});
      const parada = criarParadaPorSinal({ armado: false, aoReceber: (sinal, ordem) => { process.stderr.write('sinal ' + sinal + ' #' + ordem + '\\n'); } });
      parada.armar();
      process.stdout.write('armado\\n');
      setTimeout(() => {
        parada.encerrar();
        process.exitCode = parada.deveParar() ? saidaDoSinal(parada.sinal()) : 0;
      }, 800);
    `);
    await esperarTexto(armado, 'stdout', /armado\n/);
    armado.filho.kill('SIGTERM');
    const a = await armado.termino;
    assert.deepEqual([a.codigo, a.sinal], [143, null], 'armada, o sinal virou pedido e o processo saiu sozinho');
    assert.equal(a.stderr, 'sinal SIGTERM #1\n');
  });
});
