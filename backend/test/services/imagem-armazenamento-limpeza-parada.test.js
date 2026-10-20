'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const S = require('../../src/services/imagem-armazenamento-limpeza.service');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, G7): PARADA COOPERATIVA. `deveParar()` (opção do serviço, ausente = nunca para) é consultada ANTES de cada conjunto e nunca
 * durante: o conjunto em andamento SEMPRE termina (remoção completa e fim da transação); nenhum conjunto novo começa depois do pedido (sem transação, sem trava da biblioteca, sem
 * remoção); o que não começou conta em `restantes` e o relatório diz `paradaSolicitada: true`; a trava de janela é solta pelo token como em qualquer desfecho. Pedido que não
 * deixou de fazer nada (chegou depois do último conjunto) não é parada. A simulação não consulta o pedido. Diretórios temporários, banco falso e dados fictícios.
 */

const { AGORA, DIA } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
const mundo = (opcoes) => a.criarMundo(novaRaiz, opcoes);
const executar = (m, extra = {}) => S.limparOrfaos(m.banco, {
  diretorio: m.raiz, fs: m.fs, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, janela: { arquivo: m.arquivoDaJanela }, ...extra,
});
const tres = (prefixo) => [{ semente: `${prefixo}-a`, idadeMin: 3 * DIA }, { semente: `${prefixo}-b`, idadeMin: 4 * DIA }, { semente: `${prefixo}-c`, idadeMin: 5 * DIA }];
const trava = (m) => m.eventos.filter((e) => e.tipo === 'TRAVA').length;

describe('[STP] pedido de parada: o conjunto em andamento termina e nenhum outro começa', () => {
  test('STP-01 — pedido DEPOIS do primeiro conjunto: o segundo não começa (nenhuma trava da biblioteca, nenhuma remoção); o que já saiu fica; os dois não iniciados contam em `restantes`; a trava de janela é solta', async () => {
    const m = mundo({ orfaos: tres('stp1') });
    let parar = false;
    const r = await executar(m, { deveParar: () => parar, ganchos: { aposRemover: async () => { parar = true; } } });
    assert.equal(r.paradaSolicitada, true);
    assert.equal(r.removidos.length, 1);
    assert.deepEqual([r.restantes, r.resumo.restantes], [2, 2]);
    assert.deepEqual([r.falhas, r.ignorados], [[], []]);
    assert.equal(trava(m), 1, 'só o primeiro conjunto tomou a trava da biblioteca');
    assert.equal(m.destrutivas().length, 4, 'três arquivos e a pasta do primeiro conjunto, nada além');
    const feito = r.removidos[0].hash;
    for (const orfao of m.orfaos) assert.equal(orfao.existe(), orfao.hash !== feito, orfao.hash === feito ? 'o primeiro saiu' : 'os não iniciados ficam inteiros');
    for (const orfao of m.orfaos.filter((o) => o.hash !== feito)) assert.equal(orfao.nomes().length, 3);
    assert.equal(r.janela.estado, 'LIBERADA');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes);
  });

  test('STP-02 — pedido FEITO COM O CONJUNTO EM ANDAMENTO (antes de remover): ele termina por inteiro (todos os arquivos, a pasta e o COMMIT) e só então a execução para', async () => {
    const m = mundo({ orfaos: tres('stp2') });
    let parar = false;
    const r = await executar(m, { deveParar: () => parar, ganchos: { antesDeRemover: async () => { parar = true; } } });
    assert.equal(r.paradaSolicitada, true);
    assert.equal(r.removidos.length, 1);
    assert.equal(r.removidos[0].arquivos.length, 3, 'o conjunto em andamento não é abandonado no meio');
    assert.equal(r.removidos[0].pastaRemovida, true);
    assert.equal(r.resumo.bytesLiberados, 540);
    assert.equal(r.restantes, 2);
    const ultimaRemocao = a.ultimo(m.eventos, (e) => e.tipo === 'FS');
    const ultimoCommit = a.ultimo(m.eventos, (e) => e.tipo === 'COMMIT');
    assert.ok(ultimaRemocao >= 0 && ultimoCommit > ultimaRemocao, 'o COMMIT do conjunto vem depois da última remoção');
    assert.equal(a.ultimo(m.eventos, (e) => e.tipo === 'BEGIN') < ultimoCommit, true, 'nenhuma transação nova depois do COMMIT do conjunto em andamento');
    assert.equal(trava(m), 1);
  });

  test('STP-03 — pedido ANTES do primeiro conjunto (durante o planejamento): nada começa — sem transação de conjunto, sem trava, sem remoção; todos os candidatos contam em `restantes`; a trava de janela é solta', async () => {
    const m = mundo({ orfaos: tres('stp3') });
    let parar = false;
    const r = await executar(m, { deveParar: () => parar, ganchos: { aposPlanejar: async () => { parar = true; } } });
    assert.equal(r.paradaSolicitada, true);
    assert.deepEqual([r.removidos, r.falhas, r.ignorados], [[], [], []]);
    assert.deepEqual([r.restantes, r.resumo.restantes], [3, 3]);
    assert.equal(trava(m), 0);
    assert.deepEqual(m.destrutivas(), []);
    for (const orfao of m.orfaos) assert.equal(orfao.nomes().length, 3);
    assert.equal(r.janela.estado, 'LIBERADA');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes);
  });

  test('STP-04 — com `limite`: `restantes` soma o que passou do limite e o que a parada impediu (limite 2 de 4 candidatos, parada depois do primeiro: restantes 3)', async () => {
    const m = mundo({ orfaos: [...tres('stp4'), { semente: 'stp4-d', idadeMin: 6 * DIA }] });
    let parar = false;
    const r = await executar(m, { limite: 2, deveParar: () => parar, ganchos: { aposRemover: async () => { parar = true; } } });
    assert.equal(r.paradaSolicitada, true);
    assert.equal(r.removidos.length, 1);
    assert.deepEqual([r.restantes, r.resumo.restantes, r.limite], [3, 3, 2]);
    assert.equal(m.orfaos.filter((o) => o.existe()).length, 3);
  });

  test('STP-05 — a consulta é feita ANTES de cada conjunto e nunca durante (três conjuntos: consultas com 0, 1 e 2 conjuntos já iniciados); sem pedido, tudo é removido e `paradaSolicitada` é falso', async () => {
    const m = mundo({ orfaos: tres('stp5') });
    const consultas = [];
    const r = await executar(m, { deveParar: () => { consultas.push(trava(m)); return false; } });
    assert.deepEqual(consultas, [0, 1, 2]);
    assert.equal(r.paradaSolicitada, false);
    assert.equal(r.removidos.length, 3);
    assert.equal(r.restantes, 0);
  });

  test('STP-06 — sem `deveParar` o comportamento não muda: `paradaSolicitada` é falso em todo relatório (execução e recusa por política; a simulação, no STP-08)', async () => {
    const m = mundo({ orfaos: tres('stp6') });
    const r = await executar(m);
    assert.equal(r.paradaSolicitada, false);
    assert.equal(r.removidos.length, 3);
    const outro = mundo({ orfaos: tres('stp6b') });
    const recusada = await S.limparOrfaos(outro.banco, { diretorio: outro.raiz, fs: outro.fs, executar: true, agora: () => AGORA });
    assert.equal(recusada.recusa?.codigo, 'INTERVALO_DE_BACKUP_NAO_INFORMADO');
    assert.equal(recusada.paradaSolicitada, false);
    assert.equal(outro.banco.contadores.conexoes, 0, 'a recusa por política não lê o banco');
  });

  test('STP-07 — pedido DEPOIS do último conjunto não é parada: nada deixou de ser feito (`paradaSolicitada` falso, `restantes` 0) e tudo foi removido', async () => {
    const m = mundo({ orfaos: tres('stp7') });
    let consultas = 0;
    let parar = false;
    const r = await executar(m, { deveParar: () => { consultas += 1; return parar; }, ganchos: { aposRemover: async () => { if (trava(m) === 3) parar = true; } } });
    assert.equal(r.paradaSolicitada, false);
    assert.deepEqual([r.removidos.length, r.restantes], [3, 0]);
    assert.equal(consultas, 3, 'não há consulta depois do último conjunto');
  });

  test('STP-08 — a SIMULAÇÃO não consulta o pedido de parada (só lê): lista todos os candidatos e `paradaSolicitada` é falso', async () => {
    const m = mundo({ orfaos: tres('stp8') });
    let consultas = 0;
    const r = await S.limparOrfaos(m.banco, { diretorio: m.raiz, fs: m.fs, agora: () => AGORA, deveParar: () => { consultas += 1; return true; } });
    assert.equal(r.modo, 'SIMULACAO');
    assert.equal(r.candidatos.length, 3);
    assert.equal(r.paradaSolicitada, false);
    assert.equal(consultas, 0);
  });

  test('STP-09 — `deveParar` que não é função é TypeError e NADA é lido (nenhuma conexão ao banco, nenhuma trava de janela)', async () => {
    const m = mundo({ orfaos: tres('stp9') });
    for (const invalido of [null, 1, 'sim', {}, true]) {
      await assert.rejects(executar(m, { deveParar: invalido }), TypeError, String(invalido));
    }
    assert.equal(m.banco.contadores.conexoes, 0);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    for (const orfao of m.orfaos) assert.equal(orfao.nomes().length, 3);
  });

  test('STP-10 — pedido junto com uma falha de remoção: a falha é relatada (o conjunto vai para `falhas`), o seguinte não começa, a parada é registrada e a trava de janela é solta', async () => {
    const m = mundo({ orfaos: [{ semente: 'stp10-a', idadeMin: 3 * DIA }, { semente: 'stp10-b', idadeMin: 4 * DIA }], falhasFs: [{ metodo: 'unlink', ondeTermina: 'mestre.png', codigo: 'EIO' }] });
    let parar = false;
    const r = await executar(m, { deveParar: () => parar, ganchos: { aposRemover: async () => { parar = true; } } });
    assert.equal(r.paradaSolicitada, true);
    assert.deepEqual(r.falhas.map((f) => [f.codigo, f.codigoSistema]), [['FALHA_AO_REMOVER', 'EIO']]);
    assert.deepEqual([r.removidos.length, r.restantes], [0, 1]);
    assert.equal(trava(m), 1);
    assert.equal(r.janela.estado, 'LIBERADA');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
  });
});
