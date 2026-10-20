'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('../helpers/limpeza-orfaos');

/**
 * Comando `imagens:limpar-orfaos` (P-ORF-01, G5): ERROS INESPERADOS DA EXECUÇÃO e SANITIZAÇÃO das mensagens. Complementa imagens-limpar-orfaos-cli.test.js (CLO-01 a 25), que
 * não toca neste ramo. Decisão de Ramires em 19/10/2026: erro inesperado de execução SAI COM 1 (nunca 6, 7 ou 8, que continuam significando janela ocupada, execução recusada e
 * execução com falha ao remover); a saída mostra só o código técnico (e a mensagem dos erros que o próprio módulo produz), nunca a mensagem original de E/S ou do banco, que pode
 * levar caminho, usuário ou segredo; o relatório do que já foi feito sai junto (texto: INTERROMPIDA; JSON: `interrompido`, `erro` e `relatorio`) e a trava de janela é solta.
 *   executarComando devolve { saida, resultado }, com `resultado` = o relatório parcial (ou null quando nada foi planejado). `descreverFalha(erro)` é exportada para teste.
 */

const CLI = () => exigirModulo('scripts/imagens-limpar-orfaos');
const { AGORA, DIA } = a;
const SEGREDO = 'SEGREDO-DO-AMBIENTE-DO-TESTE-CLI-ERROS-5530';
const BANCO = { nome: 'gestao_epi_teste_local', oid: '16384' };
const DESTINO = { banco: BANCO.nome, oid: BANCO.oid };
const execucao = { executar: true, intervaloBackupMinutos: 60, destino: DESTINO };

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
const mundo = (opcoes = {}) => a.criarMundo(novaRaiz, { ...opcoes, bancoOpcoes: { banco: BANCO, ...(opcoes.bancoOpcoes ?? {}) } });
const opcoesDe = (extra = {}) => ({ json: false, executar: false, retencaoMinutos: 1500, intervaloBackupMinutos: null, limite: 50, destino: null, ...extra });

/** Captura separada: o que vai para a saída padrão e o que vai para a de erro. */
function capturar() {
  const out = [];
  const err = [];
  const juntar = (partes) => partes.map(String).join(' ');
  return { saida: { log: (...p) => { out.push(juntar(p)); }, error: (...p) => { err.push(juntar(p)); } }, out, err, tudo: () => [...out, ...err].join('\n') };
}
const comando = (m, extra = {}, dependencias = {}) => {
  const c = capturar();
  const chamada = CLI().executarComando(opcoesDe(extra), { pool: m.banco, diretorio: m.raiz, janelaArquivo: m.arquivoDaJanela, saida: c.saida, agora: () => AGORA, fs: m.fs, ...dependencias });
  return { chamada, c };
};
const erroDeES = (mensagem, code = 'EIO') => Object.assign(new Error(mensagem), { code });

describe('[CLO] erro inesperado da execução: saída 1, sem vazar a mensagem original', () => {
  test('CLO-26 — erro de E/S no meio da execução (mensagem com caminho absoluto e segredo): saída 1 (nunca 6, 7 ou 8), só o código EIO na saída, relatório parcial junto (INTERROMPIDA), trava solta e nada removido', async () => {
    const m = mundo({ orfaos: [{ semente: 'c26', idadeMin: 3 * DIA }] });
    const mensagem = `falha no disco em ${m.raiz}/7 usando ${SEGREDO}\u001b[2J`;
    const { chamada, c } = comando(m, execucao, { ganchos: { antesDeRemover: async () => { throw erroDeES(mensagem); } } });
    const { saida, resultado } = await chamada;
    const texto = c.tudo();
    assert.equal(saida, 1);
    assert.match(texto, /EIO/);
    assert.match(texto, /INTERROMPIDA/);
    assert.match(texto, /CANDIDATOS \(1\)/, 'o que já foi planejado sai junto');
    for (const proibido of [m.raiz, SEGREDO, m.pastaDaTrava, '\u001b']) assert.equal(texto.includes(proibido), false, `vazou: ${JSON.stringify(proibido)}`);
    assert.equal(a.saidaLimpa(texto, m.raiz), true);
    assert.equal(resultado.janela.estado, 'LIBERADA');
    assert.equal(resultado.candidatos.length, 1);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a trava foi solta');
    assert.equal(m.orfaos[0].existe(), true);
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes);
  });

  test('CLO-27 — o mesmo erro com `--json`: a saída padrão leva UM documento { banco, destinoConfere, interrompido, erro, relatorio } (relatório parcial) e a de erro, só o código; nada de mensagem original', async () => {
    const m = mundo({ orfaos: [{ semente: 'c26b', idadeMin: 3 * DIA }] });
    const mensagem = `falha em ${m.raiz} com ${SEGREDO}`;
    const { chamada, c } = comando(m, { ...execucao, json: true }, { ganchos: { antesDeRemover: async () => { throw erroDeES(mensagem); } } });
    const { saida } = await chamada;
    assert.equal(saida, 1);
    assert.equal(c.out.length, 1);
    const documento = JSON.parse(c.out[0]);
    assert.deepEqual(documento.banco, BANCO);
    assert.equal(documento.destinoConfere, true);
    assert.equal(documento.interrompido, true);
    assert.equal(documento.erro, 'EIO');
    assert.equal(documento.relatorio.modo, 'EXECUCAO');
    assert.equal(documento.relatorio.janela.estado, 'LIBERADA');
    assert.match(c.err.join('\n'), /EIO/);
    for (const proibido of [m.raiz, SEGREDO]) assert.equal(c.tudo().includes(proibido), false);
  });

  test('CLO-28 — a trava de janela é perdida durante a execução: saída 1 com JANELA_PERDIDA, relatório parcial com a janela PERDIDA, aviso para conferir o backup, nada removido e a trava alheia intacta', async () => {
    const m = mundo({ orfaos: [{ semente: 'c27', idadeMin: 3 * DIA }] });
    let alheia;
    const { chamada, c } = comando(m, execucao, { ganchos: { antesDeRemover: async () => {
      fs.rmSync(m.arquivoDaJanela);
      a.escreverTravaAlheia(m.arquivoDaJanela, { tipo: 'BACKUP', pid: 4242 });
      alheia = fs.readFileSync(m.arquivoDaJanela);
    } } });
    const { saida, resultado } = await chamada;
    const texto = c.tudo();
    assert.equal(saida, 1);
    assert.match(texto, /JANELA_PERDIDA/);
    assert.match(texto, /PERDIDA/);
    assert.match(texto, /confira se um backup estava em andamento antes de repetir a execução/);
    assert.equal(resultado.janela.estado, 'PERDIDA');
    assert.deepEqual(m.destrutivas(), []);
    assert.equal(m.orfaos[0].existe(), true);
    assert.deepEqual(fs.readFileSync(m.arquivoDaJanela), alheia);
    assert.equal(a.saidaLimpa(texto, m.raiz), true);
  });

  test('CLO-29 — um arquivo muda entre a conferência e a remoção: saída 1 com ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO, o conjunto em andamento identificado (hash abreviado), nada removido além do já relatado, trava solta', async () => {
    const m = mundo({ orfaos: [{ semente: 'c28', idadeMin: 3 * DIA }] });
    const alvo = m.orfaos[0].caminhos['mestre.png'];
    const { chamada, c } = comando(m, execucao, { ganchos: { antesDeRemover: async () => {
      const temporario = `${alvo}.troca`;
      fs.writeFileSync(temporario, fs.readFileSync(alvo));
      a.envelhecer(temporario, 3 * DIA);
      fs.renameSync(temporario, alvo);
    } } });
    const { saida } = await chamada;
    const texto = c.tudo();
    assert.equal(saida, 1);
    assert.match(texto, /ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO/);
    assert.match(texto, new RegExp(`pasta ${m.orfaos[0].hash.slice(0, 12)}…`));
    assert.equal(texto.includes(m.orfaos[0].hash), false, 'o texto abrevia o hash');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(a.saidaLimpa(texto, m.raiz), true);
  });

  test('CLO-30 — o banco falha logo na identificação da conexão (mensagem com usuário, host e segredo): saída 1, só o código do PostgreSQL, nenhuma leitura de disco, nenhuma trava e nada na saída além do código', async () => {
    const m = mundo({ orfaos: [{ semente: 'c29', idadeMin: 3 * DIA }] });
    const banco = a.criarBancoDeLimpeza({
      empresas: [7], banco: BANCO, aoConsultar: () => { throw erroDeES(`password authentication failed for user "app" host=10.0.0.5 ${SEGREDO}`, '28P01'); },
    });
    const { chamada, c } = comando(m, execucao, { pool: banco });
    const { saida, resultado } = await chamada;
    const texto = c.tudo();
    assert.equal(saida, 1);
    assert.equal(resultado, null);
    assert.match(texto, /28P01/);
    for (const proibido of ['password', 'authentication', '10.0.0.5', SEGREDO, 'app']) assert.equal(texto.includes(proibido), false, `vazou: ${proibido}`);
    assert.deepEqual(m.chamadas, []);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(m.orfaos[0].existe(), true);
  });

  test('CLO-31 — a distinção das saídas se mantém: erro inesperado depois de uma falha de remoção sai 1 (não 8), e as três situações previstas seguem 6 (janela ocupada), 7 (recusada) e 8 (falha ao remover)', async () => {
    const mista = mundo({ orfaos: [{ semente: 'c30-a', idadeMin: 3 * DIA }, { semente: 'c30-b', idadeMin: 3 * DIA }] });
    const [primeiro] = [...mista.orfaos].sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const quebrado = a.fachadaDeLimpeza(mista.raiz, { eventos: mista.eventos, falhas: [{ metodo: 'unlink', ondeContem: primeiro.hash, codigo: 'EACCES' }] });
    let chamadas = 0;
    const { chamada, c } = comando(mista, execucao, { fs: quebrado.fs, ganchos: { antesDeRemover: async () => { chamadas += 1; if (chamadas === 2) throw erroDeES('disco'); } } });
    const { saida, resultado } = await chamada;
    assert.equal(saida, 1, 'o erro inesperado vence a falha parcial anterior');
    assert.equal(resultado.falhas.length, 1);
    assert.match(c.tudo(), /FALHAS \(1\)/);

    const ocupada = mundo({ orfaos: [{ semente: 'c30-ocupada', idadeMin: 3 * DIA }] });
    a.escreverTravaAlheia(ocupada.arquivoDaJanela, { tipo: 'BACKUP', pid: 2468 });
    assert.equal((await comando(ocupada, execucao).chamada).saida, 6);

    const recusada = mundo({ orfaos: [{ semente: 'c30-recusada', idadeMin: 3 * DIA }] });
    assert.equal((await comando(recusada, { ...execucao, retencaoMinutos: 1441, intervaloBackupMinutos: 1441 }).chamada).saida, 7);

    const parcial = mundo({ orfaos: [{ semente: 'c30-parcial', idadeMin: 3 * DIA }] });
    const falha = a.fachadaDeLimpeza(parcial.raiz, { eventos: parcial.eventos, falhas: [{ metodo: 'unlink', ondeContem: parcial.orfaos[0].hash, codigo: 'EACCES' }] });
    assert.equal((await comando(parcial, execucao, { fs: falha.fs }).chamada).saida, 8);
  });
});

describe('[CLO] descreverFalha: só o que é seguro mostrar', () => {
  test('CLO-32 — só o código técnico; a mensagem só aparece nos erros do próprio módulo (limpeza, janela e configuração de imagens), sempre escapada; código com caracteres estranhos não passa', () => {
    const { descreverFalha } = CLI();
    assert.equal(typeof descreverFalha, 'function');
    assert.equal(descreverFalha(erroDeES('falha em /var/imagens/7 com segredo', 'EACCES')), 'EACCES');
    assert.equal(descreverFalha(new Error('sem código nenhum, em /var/imagens')), 'erro inesperado');
    assert.equal(descreverFalha(erroDeES('x', '\u001b[31mEIO')), 'erro inesperado', 'código fora do padrão é descartado');
    assert.equal(descreverFalha(erroDeES('x', 'A'.repeat(41))), 'erro inesperado');
    assert.equal(descreverFalha('texto solto'), 'erro inesperado');
    assert.equal(descreverFalha(null), 'erro inesperado');
    const { ErroDeLimpeza } = require('../../src/services/imagem-armazenamento-limpeza.service');
    const { ErroDeJanela } = require('../../src/utils/janela-escrita-imagens');
    const propria = descreverFalha(new ErroDeLimpeza('JANELA_PERDIDA'));
    assert.match(propria, /^JANELA_PERDIDA — /);
    assert.equal(/\p{Cc}/u.test(propria), false);
    assert.match(descreverFalha(new ErroDeJanela('JANELA_OCUPADA')), /^JANELA_OCUPADA — /);
    const configuracao = Object.assign(new Error('IMAGENS_X: valor inválido\nlinha forjada'), { codigo: 'IMAGENS_CONFIGURACAO_INVALIDA' });
    const descrita = descreverFalha(configuracao);
    assert.match(descrita, /^IMAGENS_CONFIGURACAO_INVALIDA — /);
    assert.equal(descrita.includes('\n'), false, 'a quebra de linha da mensagem não forja linhas');
    assert.equal(path.isAbsolute(descrita), false);
  });
});

describe('[CLO] a execução não depende só do interpretador de argumentos', () => {
  test('CLO-33 — executarComando chamado DIRETO (sem passar por interpretarArgumentos) recusa executar sem destino informado ou com destino errado: saída 2, DESTINO_NAO_AUTORIZADO, nada lido, nenhuma trava e nada removido', async () => {
    for (const destino of [null, { banco: 'outro_banco', oid: BANCO.oid }]) {
      const m = mundo({ orfaos: [{ semente: `c33-${destino === null ? 'sem' : 'errado'}`, idadeMin: 3 * DIA }] });
      const { chamada, c } = comando(m, { executar: true, intervaloBackupMinutos: 60, destino });
      const { saida, resultado } = await chamada;
      assert.equal(saida, 2);
      assert.equal(resultado, null);
      assert.match(c.tudo(), /DESTINO_NAO_AUTORIZADO/);
      assert.equal(m.banco.sql.length, 1, 'só a identificação do banco');
      assert.deepEqual(m.chamadas, []);
      assert.deepEqual(m.destrutivas(), []);
      assert.equal(fs.existsSync(m.arquivoDaJanela), false);
      assert.equal(m.orfaos[0].existe(), true);
    }
  });
});
