'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const childProcess = require('node:child_process');
const { jpegDeSaidaGrande } = require('../helpers/imagem-saida-grande');
const { gerarVariantes } = require('../helpers/filhos/sucesso-adulterado');
const F = require('../helpers/imagens-reais');
const servico = require('../../src/services/imagem-processador.service');
const worker = require('../../src/workers/imagem-processador.worker');
const { serializarSucesso } = require('../../src/utils/imagem-quadro');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (T-01, mutante W54) — a SAÍDA GRANDE do filho. O quadro de resposta passa de 2 MiB e o pipe da saída padrão comporta 64 KiB: se o
 * filho encerrasse logo depois do write, sem esperar o descarregamento, a resposta chegaria cortada em 65.536 bytes. Estes testes usam o filho REAL e um leitor que só começa
 * a ler depois de um atraso: o quadro tem de chegar inteiro, byte a byte igual ao processamento no próprio processo, e quem chama só pode considerar o filho terminado quando
 * os canais fecham ('close'), não quando o processo sai ('exit'): o último pedaço da saída ainda pode estar no pipe.
 */

const MIB = 1024 * 1024;
const teste = (nome, fn) => test(nome, { timeout: 90000 }, fn);
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Executa o worker real e lê a saída só depois de `atrasoMs`. O filho é encerrado por SIGKILL se o teste estourar o próprio prazo (só ele, pela referência que este teste criou). */
function lerComAtraso(execucao, entrada, atrasoMs) {
  return new Promise((resolve, reject) => {
    const filho = childProcess.spawn(execucao.comando, execucao.argumentos, execucao.opcoes);
    const partes = [];
    let total = 0;
    let bytesNoExit = null;
    const limite = setTimeout(() => { filho.kill('SIGKILL'); reject(new Error('o filho não terminou no prazo do teste')); }, 60000);
    filho.stdout.pause();
    const retomada = setTimeout(() => filho.stdout.resume(), atrasoMs);
    filho.stdout.on('data', (bloco) => { partes.push(bloco); total += bloco.length; });
    filho.stderr.on('data', () => {});
    filho.stdin.on('error', () => {});
    filho.once('exit', () => { bytesNoExit = total; });
    filho.once('close', (codigo, sinal) => { clearTimeout(limite); clearTimeout(retomada); resolve({ codigo, sinal, quadro: Buffer.concat(partes), bytesNoExit }); });
    filho.stdin.end(entrada);
  });
}

describe('saída grande do filho (T-01)', () => {
  teste('SGR-01 — o worker REAL, com leitor deliberadamente atrasado, entrega o quadro inteiro: mesmo tamanho e mesmo conteúdo do processamento no próprio processo', async () => {
    const entrada = await jpegDeSaidaGrande();
    const parametros = servico.parametrosDoProcessamento();
    assert.ok(entrada.length < parametros.entradaMaxBytes, `entrada de ${entrada.length} bytes`);
    const esperado = serializarSucesso(await worker.processarImagem(entrada, parametros));
    assert.ok(esperado.length > MIB, `o quadro de referência precisa passar de 1 MiB e tem ${esperado.length} bytes`);
    const execucao = servico.montarExecucaoDoFilho({ parametros });
    for (const atraso of [0, 700]) {
      const r = await lerComAtraso(execucao, entrada, atraso);
      assert.deepEqual([r.codigo, r.sinal], [0, null], `atraso ${atraso} ms`);
      assert.equal(r.quadro.length, esperado.length, `atraso ${atraso} ms: chegaram ${r.quadro.length} de ${esperado.length} bytes (no 'exit' já tinham chegado ${r.bytesNoExit})`);
      assert.equal(sha(r.quadro), sha(esperado), `atraso ${atraso} ms: o conteúdo difere do esperado`);
    }
  });

  teste('SGR-02 — o PROCESSADOR (lado da API) também recebe tudo quando a leitura atrasa: o resultado do filho real é idêntico ao do processamento no próprio processo', async () => {
    const entrada = await jpegDeSaidaGrande();
    const parametros = servico.parametrosDoProcessamento();
    const referencia = await worker.processarImagem(entrada, parametros);
    const criados = [];
    const retomadas = [];
    const spawnar = (...argumentos) => {
      const filho = childProcess.spawn(...argumentos);
      criados.push(filho);
      filho.stdout.pause();
      retomadas.push(setTimeout(() => filho.stdout.resume(), 700));
      return filho;
    };
    const processador = servico.criarProcessadorDeImagens({ parametros, prazoExternoMs: 60000, spawnar });
    try {
      const r = await processador.processar(entrada);
      for (const nome of ['mestre', 'exibicao', 'miniatura']) assert.equal(sha(r[nome]), sha(referencia[nome]), `${nome} difere do esperado`);
      assert.ok(r.mestre.length + r.exibicao.length + r.miniatura.length > MIB);
      assert.deepEqual(processador.ativos(), []);
    } finally {
      retomadas.forEach(clearTimeout);
      for (const filho of criados) { if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL'); }
    }
  });

  teste('SGR-03 — o processador só dá o filho por terminado quando os canais fecham (close), não quando o processo sai (exit): com o exit chegando ANTES do fim da saída, o resultado ainda vem inteiro', async () => {
    const variantes = await gerarVariantes();
    const quadro = serializarSucesso({ formato: 'PNG', largura: 1024, altura: 1024, ...variantes });
    const corte = Math.floor(quadro.length / 2);
    const falso = new EventEmitter();
    falso.pid = 424243;
    falso.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    falso.stdout = new PassThrough();
    falso.stderr = new PassThrough();
    falso.kill = () => true;
    falso.stdin.on('finish', () => setImmediate(() => {
      falso.stdout.write(quadro.subarray(0, corte));
      falso.emit('exit', 0, null);
      setTimeout(() => {
        falso.stdout.once('end', () => falso.emit('close', 0, null));
        falso.stdout.end(quadro.subarray(corte));
        falso.stderr.end();
      }, 80);
    }));
    const processador = servico.criarProcessadorDeImagens({ spawnar: () => falso, prazoExternoMs: 30000 });
    const r = await processador.processar(await F.png(400, 320));
    for (const nome of ['mestre', 'exibicao', 'miniatura']) assert.ok(r[nome].equals(variantes[nome]), `${nome} difere do esperado`);
    assert.deepEqual(processador.ativos(), []);
  });
});
