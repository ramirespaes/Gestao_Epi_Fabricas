'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const servico = require('../../src/services/imagem-processador.service');
const { lerQuadro } = require('../../src/utils/imagem-quadro');
const { ErroDeImagem } = require('../../src/utils/imagem-container');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (T-02, mutantes W51, W52, W57 e W58) — o WORKER REAL COMO PROCESSO: os caminhos de saída de principal(), que os testes em processo não
 * alcançam. Saída 0 com quadro (sucesso ou recusa), 1 falha inesperada, 2 parâmetros inválidos, 3 sharp indisponível (e 124, o relógio de sobrevivência, em
 * test/security/imagem-processador-isolamento.test.js). Cada caso roda num filho isolado, com o ambiente mínimo do serviço; o sharp indisponível e a falha inesperada são
 * simulados por pré-cargas de teste (test/helpers/pre-carga), que só existem dentro do filho do teste. Nenhum byte de erro do filho pode chegar a quem chama.
 */

const teste = (nome, fn) => test(nome, { timeout: 90000 }, fn);
const PRE_CARGA = path.join(__dirname, '..', 'helpers', 'pre-carga');
const SEM_SHARP = path.join(PRE_CARGA, 'sem-sharp.js');
const FALHA_NA_GERACAO = path.join(PRE_CARGA, 'falha-na-geracao.js');
const TETOS = Object.freeze({ mestreMax: 4 * 1024 * 1024, exibicaoMax: 512 * 1024, miniaturaMax: 65536 });

/** Executa o worker real como processo; `argumento` troca o JSON de parâmetros (null = sem argumento). O filho é morto por SIGKILL, só ele, se estourar o prazo do teste. */
function executar({ argumento, preCarga, ambiente = {}, entrada = Buffer.alloc(0) }) {
  const execucao = servico.montarExecucaoDoFilho({ parametros: servico.parametrosDoProcessamento() });
  const argumentos = [...execucao.argumentos];
  if (argumento === null) argumentos.pop();
  else if (argumento !== undefined) argumentos[argumentos.length - 1] = argumento;
  if (preCarga) argumentos.unshift('--require', preCarga);
  return new Promise((resolve, reject) => {
    const filho = childProcess.spawn(execucao.comando, argumentos, { ...execucao.opcoes, env: { ...execucao.opcoes.env, ...ambiente } });
    const saida = [];
    const erro = [];
    const limite = setTimeout(() => { filho.kill('SIGKILL'); reject(new Error('o worker não terminou no prazo do teste')); }, 60000);
    filho.stdout.on('data', (b) => saida.push(b));
    filho.stderr.on('data', (b) => erro.push(b));
    filho.stdin.on('error', () => {});
    filho.once('close', (codigo, sinal) => { clearTimeout(limite); resolve({ codigo, sinal, stdout: Buffer.concat(saida), stderr: Buffer.concat(erro).toString('utf8') }); });
    filho.stdin.end(entrada);
  });
}

describe('worker real como processo (T-02)', () => {
  teste('WPR-01 — parâmetros inválidos (JSON ruim, não objeto, chave extra, número fora da faixa, argumento ausente) → saída 2, stderr só PARAMETROS_INVALIDOS, nada na saída padrão', async () => {
    const bons = servico.parametrosDoProcessamento();
    const argumentos = { 'JSON ruim': '{', 'não é objeto': '[]', 'chave extra': JSON.stringify({ ...bons, extra: 1 }), 'pixelsMax zero': JSON.stringify({ ...bons, pixelsMax: 0 }), 'sem argumento': null };
    for (const [nome, argumento] of Object.entries(argumentos)) {
      const r = await executar({ argumento, entrada: await F.png(400, 320) });
      assert.deepEqual([r.codigo, r.sinal], [2, null], nome);
      assert.equal(r.stderr, 'PARAMETROS_INVALIDOS', nome);
      assert.equal(r.stdout.length, 0, nome);
    }
  });

  teste('WPR-02 — sharp indisponível no servidor → saída 3, stderr só SHARP_INDISPONIVEL (nem a mensagem nem o caminho do erro de carga), nada na saída padrão', async () => {
    const r = await executar({ preCarga: SEM_SHARP, entrada: await F.png(400, 320) });
    assert.deepEqual([r.codigo, r.sinal], [3, null]);
    assert.equal(r.stderr, 'SHARP_INDISPONIVEL');
    assert.equal(r.stdout.length, 0);
  });

  teste('WPR-03 — falha inesperada na geração das variantes → saída 1 e stderr só com FALHA_ e o código do erro (cortado em 60 caracteres); sem código, FALHA_INESPERADA; a mensagem e o caminho nunca saem; nada na saída padrão', async () => {
    const entrada = await F.png(400, 320);
    const com = await executar({ preCarga: FALHA_NA_GERACAO, ambiente: { PRE_CARGA_CODIGO: 'EXPLOSAO_CONTROLADA' }, entrada });
    assert.deepEqual([com.codigo, com.sinal, com.stderr, com.stdout.length], [1, null, 'FALHA_EXPLOSAO_CONTROLADA', 0]);
    const sem = await executar({ preCarga: FALHA_NA_GERACAO, entrada });
    assert.deepEqual([sem.codigo, sem.sinal, sem.stderr, sem.stdout.length], [1, null, 'FALHA_INESPERADA', 0]);
    const longo = await executar({ preCarga: FALHA_NA_GERACAO, ambiente: { PRE_CARGA_CODIGO: 'X'.repeat(80) }, entrada });
    assert.deepEqual([longo.codigo, longo.stderr], [1, `FALHA_${'X'.repeat(60)}`]);
    for (const r of [com, sem, longo]) assert.ok(!/SEGREDO-NA-MENSAGEM|\/caminho\/secreto|explosão de teste/.test(r.stderr));
  });

  teste('WPR-04 — recusa de imagem sai com 0 e um quadro de recusa na saída padrão (PNG com CRC ruim → IMAGEM_INVALIDA), sem nada no stderr; sucesso sai com 0 e um quadro de sucesso', async () => {
    const recusa = await executar({ entrada: F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' })) });
    assert.deepEqual([recusa.codigo, recusa.sinal, recusa.stderr], [0, null, '']);
    assert.deepEqual(lerQuadro(recusa.stdout, TETOS), { ok: false, codigo: 'IMAGEM_INVALIDA' });
    const sucesso = await executar({ entrada: await F.png(400, 320) });
    assert.deepEqual([sucesso.codigo, sucesso.sinal, sucesso.stderr], [0, null, '']);
    const quadro = lerQuadro(sucesso.stdout, TETOS);
    assert.deepEqual([quadro.ok, quadro.formato, quadro.largura, quadro.altura], [true, 'PNG', 1024, 1024]);
  });

  teste('WPR-05 — de ponta a ponta pelo processador: sharp indisponível vira IMAGENS_INDISPONIVEL (o 503 do envio) e falha inesperada vira IMAGEM_FILHO_CODIGO_SAIDA, ambos erros internos sem a mensagem do filho; nenhum filho sobra', async () => {
    const criados = [];
    const comPreCarga = (arquivo, ambiente = {}) => (comando, argumentos, opcoes) => {
      const filho = childProcess.spawn(comando, ['--require', arquivo, ...argumentos], { ...opcoes, env: { ...opcoes.env, ...ambiente } });
      criados.push(filho);
      return filho;
    };
    const entrada = await F.png(400, 320);
    try {
      for (const [spawnar, codigo] of [[comPreCarga(SEM_SHARP), 'IMAGENS_INDISPONIVEL'], [comPreCarga(FALHA_NA_GERACAO, { PRE_CARGA_CODIGO: 'EXPLOSAO' }), 'IMAGEM_FILHO_CODIGO_SAIDA']]) {
        const processador = servico.criarProcessadorDeImagens({ spawnar, prazoExternoMs: 30000 });
        const erro = await processador.processar(entrada).then(() => null, (e) => e);
        assert.ok(erro instanceof Error && !(erro instanceof ErroDeImagem), String(erro?.message));
        assert.equal(erro.codigo, codigo);
        assert.ok(!/SEGREDO-NA-MENSAGEM|\/caminho\/secreto|explosão de teste/.test(`${erro.message}${erro.stack}`));
        assert.deepEqual(processador.ativos(), []);
      }
    } finally {
      for (const filho of criados) { if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL'); }
    }
  });
});
