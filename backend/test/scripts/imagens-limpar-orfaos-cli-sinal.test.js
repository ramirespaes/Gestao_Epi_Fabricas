'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('../helpers/limpeza-orfaos');

/**
 * Comando `imagens:limpar-orfaos` (P-ORF-01, G7): SINAIS SIGINT e SIGTERM. Decisão de Ramires em 19/10/2026: ao receber o sinal o comando NÃO inicia novos conjuntos, conclui a
 * operação em andamento e solta SÓ a trava cuja posse o token confirma (nunca a de outro). Só na EXECUÇÃO (a simulação não toma trava nem apaga nada: o sinal a encerra como
 * sempre). O comando recebe `parada` ({ deveParar(), sinal(), encerrar() }, a de `src/utils/parada-por-sinal.js`) e a repassa ao serviço; `criarParadaDoComando(interpretado,
 * { processo, saida })` a monta (nula na simulação), DESARMADA, e avisa em STDERR, nunca em stdout (o JSON continua um documento só). `executarComando` a arma (`armar`) imediatamente antes do
 * serviço, quando a trava passa a existir: antes disso (conexão ao banco, conferência do destino) Ctrl-C mata o processo como sempre.
 *   - saída: 128 + número do sinal (SIGINT 130, SIGTERM 143) quando o pedido impediu o início de algum conjunto e nada mais a muda; falha ao remover (8) e erro inesperado (1) prevalecem;
 *     `SAIDAS` não muda (CLO-01).
 *   - texto: "EXECUÇÃO PARADA POR SINAL (<sinal>)" no cabeçalho e, no fim, "Parada pedida por <sinal>: ..."; sinal tardio (nada deixou de ser feito): "Sinal <sinal> recebido depois
 *     do último conjunto: nada deixou de ser feito."; JSON: chave `sinal` só quando um sinal foi recebido (a forma do documento sem sinal não muda).
 */

const CLI = () => exigirModulo('scripts/imagens-limpar-orfaos');
const { AGORA, DIA } = a;
const BANCO = { nome: 'gestao_epi_teste_local', oid: '16384' };
const DESTINO = { banco: BANCO.nome, oid: BANCO.oid };
const execucao = { executar: true, intervaloBackupMinutos: 60, destino: DESTINO };

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
const mundo = (opcoes = {}) => a.criarMundo(novaRaiz, { ...opcoes, bancoOpcoes: { banco: BANCO, ...(opcoes.bancoOpcoes ?? {}) } });
const tres = (prefixo) => [{ semente: `${prefixo}-a`, idadeMin: 3 * DIA }, { semente: `${prefixo}-b`, idadeMin: 4 * DIA }, { semente: `${prefixo}-c`, idadeMin: 5 * DIA }];

/** Saída com os dois fluxos juntos (`linhas`, para o texto) e separados (`out` é o stdout; `err`, o stderr). */
function capturar() {
  const linhas = [];
  const out = [];
  const err = [];
  const juntar = (partes) => partes.map(String).join(' ');
  return {
    saida: { log: (...p) => { linhas.push(juntar(p)); out.push(juntar(p)); }, error: (...p) => { linhas.push(juntar(p)); err.push(juntar(p)); } },
    linhas, out, err, texto: () => linhas.join('\n'),
  };
}
const opcoesDe = (extra = {}) => ({ json: false, executar: false, retencaoMinutos: 1500, intervaloBackupMinutos: null, limite: 50, destino: null, ...extra });

/** Pedido de parada controlado pelo teste (no lugar do sinal real): `pedir()` age como o sinal chegando. */
function paradaFalsa(sinal = 'SIGTERM') {
  let pedido = null;
  const consultas = { n: 0 };
  return {
    consultas,
    parada: { deveParar: () => { consultas.n += 1; return pedido !== null; }, sinal: () => pedido, encerrar() {} },
    pedir: () => { pedido = sinal; },
  };
}

function rodar(m, extra, dependencias) {
  const c = capturar();
  const chamada = CLI().executarComando(opcoesDe(extra), { pool: m.banco, diretorio: m.raiz, janelaArquivo: m.arquivoDaJanela, saida: c.saida, agora: () => AGORA, fs: m.fs, ...dependencias });
  return { chamada, c };
}
const trava = (m) => m.eventos.filter((e) => e.tipo === 'TRAVA').length;

describe('[SIG] parada por sinal no comando (parada simulada; sem sinal real)', () => {
  test('SIG-01 — SIGTERM com a execução em andamento: sai com 143; o texto diz "PARADA POR SINAL (SIGTERM)", o que foi removido, `restantes` e que o resto fica para a próxima; a trava de janela é solta', async () => {
    const m = mundo({ orfaos: tres('sig1') });
    const p = paradaFalsa('SIGTERM');
    const { chamada, c } = rodar(m, execucao, { parada: p.parada, ganchos: { aposRemover: async () => { p.pedir(); } } });
    const { saida, resultado } = await chamada;
    const texto = c.texto();
    assert.equal(saida, 143);
    assert.equal(resultado.paradaSolicitada, true);
    assert.match(texto, /EXECUÇÃO PARADA POR SINAL \(SIGTERM\)/);
    assert.match(texto, /REMOVIDOS \(1\)/);
    assert.match(texto, /Resumo: removidos=1 · ignorados=0 · falhas=0 · bytes liberados=540 · restantes=2 · limite=50/);
    assert.match(texto, /Parada pedida por SIGTERM: o conjunto em andamento foi concluído, nenhum outro foi iniciado e a trava de janela foi solta; o restante fica para a próxima execução\./);
    assert.match(texto, /Janela de escrita: tomada pela limpeza e liberada ao final/);
    assert.doesNotMatch(texto, /Nada foi removido/);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(trava(m), 1);
  });

  test('SIG-02 — SIGINT com `--json`: sai com 130 e UM documento { banco, destinoConfere, relatorio, sinal } em stdout; `sinal` só existe porque um sinal foi recebido', async () => {
    const m = mundo({ orfaos: tres('sig2') });
    const p = paradaFalsa('SIGINT');
    const { chamada, c } = rodar(m, { ...execucao, json: true }, { parada: p.parada, ganchos: { aposRemover: async () => { p.pedir(); } } });
    const { saida } = await chamada;
    assert.equal(saida, 130);
    assert.equal(c.linhas.length, 1, 'um documento só');
    const documento = JSON.parse(c.linhas[0]);
    assert.deepEqual(Object.keys(documento).sort(), ['banco', 'destinoConfere', 'relatorio', 'sinal']);
    assert.equal(documento.sinal, 'SIGINT');
    assert.equal(documento.destinoConfere, true);
    assert.equal(documento.relatorio.paradaSolicitada, true);
    assert.equal(documento.relatorio.removidos.length, 1);
    assert.equal(documento.relatorio.restantes, 2);
    assert.equal(documento.relatorio.janela.estado, 'LIBERADA');
  });

  test('SIG-03 — a falha ao remover PREVALECE: parada com um conjunto que falhou sai com 8 (não com 143), e o texto mostra a falha e a parada', async () => {
    const m = mundo({ orfaos: tres('sig3'), falhasFs: [{ metodo: 'unlink', ondeTermina: 'mestre.png', codigo: 'EIO' }] });
    const p = paradaFalsa('SIGTERM');
    const { chamada, c } = rodar(m, execucao, { parada: p.parada, ganchos: { aposRemover: async () => { p.pedir(); } } });
    const { saida, resultado } = await chamada;
    assert.equal(saida, 8);
    assert.equal(resultado.paradaSolicitada, true);
    assert.match(c.texto(), /FALHAS \(1\)/);
    assert.match(c.texto(), /EXECUÇÃO PARADA POR SINAL \(SIGTERM\)/);
    assert.match(c.texto(), /Parada pedida por SIGTERM/);
  });

  test('SIG-04 — sinal TARDIO (depois do último conjunto): nada deixou de ser feito, então sai com 0, o texto diz isso e o JSON registra o sinal sem marcar parada', async () => {
    const m = mundo({ orfaos: tres('sig4') });
    const p = paradaFalsa('SIGTERM');
    const { chamada, c } = rodar(m, execucao, { parada: p.parada, ganchos: { aposRemover: async () => { if (trava(m) === 3) p.pedir(); } } });
    const { saida, resultado } = await chamada;
    assert.equal(saida, 0);
    assert.equal(resultado.paradaSolicitada, false);
    assert.equal(resultado.removidos.length, 3);
    assert.match(c.texto(), /Sinal SIGTERM recebido depois do último conjunto: nada deixou de ser feito\./);
    assert.doesNotMatch(c.texto(), /PARADA POR SINAL|Parada pedida/);

    const m2 = mundo({ orfaos: tres('sig4j') });
    const p2 = paradaFalsa('SIGTERM');
    const json = rodar(m2, { ...execucao, json: true }, { parada: p2.parada, ganchos: { aposRemover: async () => { if (trava(m2) === 3) p2.pedir(); } } });
    assert.equal((await json.chamada).saida, 0);
    const documento = JSON.parse(json.c.linhas[0]);
    assert.equal(documento.sinal, 'SIGTERM');
    assert.equal(documento.relatorio.paradaSolicitada, false);
  });

  test('SIG-05 — sem sinal nada muda: saída 0, nenhum texto de parada e o JSON mantém a forma { banco, destinoConfere, relatorio } (CLO-18)', async () => {
    const m = mundo({ orfaos: tres('sig5') });
    const p = paradaFalsa('SIGTERM');
    const { chamada, c } = rodar(m, execucao, { parada: p.parada });
    assert.equal((await chamada).saida, 0);
    assert.doesNotMatch(c.texto(), /SINAL|Sinal|Parada pedida/);
    assert.equal(p.consultas.n, 3, 'consultada uma vez antes de cada conjunto');

    const m2 = mundo({ orfaos: tres('sig5j') });
    const j = rodar(m2, { ...execucao, json: true }, { parada: paradaFalsa().parada });
    assert.equal((await j.chamada).saida, 0);
    const documento = JSON.parse(j.c.linhas[0]);
    assert.deepEqual(Object.keys(documento).sort(), ['banco', 'destinoConfere', 'relatorio']);
    assert.equal(documento.relatorio.paradaSolicitada, false);

    const m3 = mundo({ orfaos: tres('sig5s') });
    const semParada = rodar(m3, execucao);
    assert.equal((await semParada.chamada).saida, 0, 'a dependência `parada` é opcional (testes e usos anteriores)');
  });

  test('SIG-06 — a SIMULAÇÃO ignora a parada: não a consulta, sai com 0 e não fala de sinal nem no texto nem no JSON', async () => {
    const m = mundo({ orfaos: tres('sig6') });
    const p = paradaFalsa('SIGINT');
    p.pedir();
    const { chamada, c } = rodar(m, {}, { parada: p.parada });
    const { saida, resultado } = await chamada;
    assert.equal(saida, 0);
    assert.equal(resultado.modo, 'SIMULACAO');
    assert.equal(resultado.candidatos.length, 3);
    assert.doesNotMatch(c.texto(), /SINAL|Sinal|Parada pedida/);
    assert.equal(p.consultas.n, 0);

    const m2 = mundo({ orfaos: tres('sig6j') });
    const j = rodar(m2, { json: true }, { parada: p.parada });
    assert.equal((await j.chamada).saida, 0);
    assert.deepEqual(Object.keys(JSON.parse(j.c.linhas[0])).sort(), ['banco', 'destinoConfere', 'relatorio']);
  });

  test('SIG-07 — `criarParadaDoComando`: na simulação não instala nada (devolve null); na execução nasce DESARMADA e, armada, ouve SÓ SIGINT e SIGTERM, avisa em STDERR (nunca em stdout) e `encerrar()` devolve o comportamento padrão', () => {
    const { criarParadaDoComando, interpretarArgumentos } = CLI();
    assert.equal(typeof criarParadaDoComando, 'function', 'contrato futuro: o comando ainda não tem criarParadaDoComando');
    const simulacao = interpretarArgumentos([]);
    const real = interpretarArgumentos(['--executar', '--banco-autorizado', BANCO.nome, '--banco-oid', BANCO.oid, '--intervalo-backup-minutos', '60']);
    assert.equal(simulacao.ok && real.ok, true);

    const processoA = new EventEmitter();
    const c1 = capturar();
    assert.equal(criarParadaDoComando(simulacao, { processo: processoA, saida: c1.saida }), null);
    assert.deepEqual(processoA.eventNames(), []);

    const processoB = new EventEmitter();
    const c2 = capturar();
    const parada = criarParadaDoComando(real, { processo: processoB, saida: c2.saida });
    assert.deepEqual(processoB.eventNames(), [], 'nasce desarmada: nada instalado até o comando armá-la (Ctrl-C ainda mata como sempre)');
    assert.equal(typeof parada.armar, 'function');
    parada.armar();
    assert.deepEqual(processoB.eventNames().sort(), ['SIGINT', 'SIGTERM']);
    assert.equal(parada.deveParar(), false);
    processoB.emit('SIGTERM');
    assert.equal(parada.deveParar(), true);
    assert.deepEqual(c2.err, ['Sinal SIGTERM recebido: a limpeza conclui o conjunto em andamento, não inicia outro e solta a trava de janela antes de sair.']);
    processoB.emit('SIGINT');
    assert.equal(c2.err.length, 2);
    assert.match(c2.err[1], /^Novo sinal \(SIGINT\) ignorado: a limpeza já está parando\. /);
    assert.equal(parada.sinal(), 'SIGTERM', 'o primeiro sinal vence');
    assert.deepEqual(c2.out, [], 'stdout fica livre para o relatório');
    parada.encerrar();
    assert.deepEqual(processoB.eventNames(), []);
  });

  test('SIG-09 — `executarComando` ARMA a parada imediatamente antes do serviço: depois de identificar o banco e de conferir o destino, antes de tomar a trava; nunca na simulação nem quando o destino é recusado', async () => {
    const executarObservando = async (extra) => {
      const m = mundo({ orfaos: tres('sig9') });
      const ordem = [];
      const pool = { connect: (...argumentos) => m.banco.connect(...argumentos), query: (...argumentos) => { ordem.push('banco'); return m.banco.query(...argumentos); } };
      const parada = { deveParar: () => false, sinal: () => null, armar: () => { ordem.push('armar'); }, encerrar() {} };
      const c = capturar();
      const { saida } = await CLI().executarComando(opcoesDe(extra), {
        pool, diretorio: m.raiz, janelaArquivo: m.arquivoDaJanela, saida: c.saida, agora: () => AGORA, fs: m.fs, parada, ganchos: { aposTravar: async () => { ordem.push('trava'); } },
      });
      return { ordem, saida };
    };
    const ok = await executarObservando(execucao);
    assert.equal(ok.saida, 0);
    assert.equal(ok.ordem.filter((x) => x === 'armar').length, 1, 'armada uma vez');
    assert.equal(ok.ordem[0], 'banco', 'o banco é identificado primeiro');
    assert.ok(ok.ordem.indexOf('banco') < ok.ordem.indexOf('armar'), 'o banco é identificado antes de armar');
    assert.ok(ok.ordem.indexOf('armar') < ok.ordem.indexOf('trava'), 'a parada é armada antes de tomar a trava da biblioteca');

    const simulacao = await executarObservando({});
    assert.equal(simulacao.saida, 0);
    assert.equal(simulacao.ordem.includes('armar'), false, 'a simulação nunca arma a parada');

    const recusada = await executarObservando({ ...execucao, destino: { banco: BANCO.nome, oid: '999' } });
    assert.equal(recusada.saida, 2);
    assert.equal(recusada.ordem.includes('armar'), false, 'destino recusado: nada foi lido nem armado');
    assert.equal(recusada.ordem.includes('trava'), false);
  });

  test('SIG-08 — o uso descreve a parada por sinal (SIGINT, SIGTERM, saídas 130 e 143, só na execução) e avisa que SIGKILL deixaria a trava', () => {
    const texto = CLI().uso();
    for (const trecho of ['SIGINT', 'SIGTERM', '130', '143', 'SIGKILL']) assert.ok(texto.includes(trecho), trecho);
    assert.match(texto, /conjunto em andamento/);
  });
});
