'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('../helpers/limpeza-orfaos');

/**
 * Comando `imagens:limpar-orfaos` (Biblioteca de Imagens, P-ORF-01, fase RED): INTERFACE DE LINHA DE COMANDO da limpeza de órfãos, ferramenta SEPARADA do verificador
 * (`imagens:verificar` segue somente leitura e continua recusando qualquer argumento de escrita).
 *
 * Módulo previsto: scripts/imagens-limpar-orfaos.js, na família de scripts/imagens-verificar.js (Node autônomo, executado deliberadamente por um operador ou por cron externo,
 * credenciais e caminhos SÓ pelo ambiente: DB_*, IMAGENS_ARMAZENAMENTO_DIRETORIO e IMAGENS_JANELA_ESCRITA_ARQUIVO; nada de segredo em argumento nem na saída).
 *
 *   node --require dotenv/config scripts/imagens-limpar-orfaos.js [--json] [--executar] [--retencao-minutos <n>] [--intervalo-backup-minutos <n>] [--limite <n>]
 *                                                                  [--banco-autorizado <nome> --banco-oid <oid>]
 *
 *   - SIMULAÇÃO é o padrão. `--executar` só é aceito COM `--banco-autorizado` e `--banco-oid` (conferidos na conexão ANTES de ler qualquer imagem) e COM
 *     `--intervalo-backup-minutos` (sem ele não se prova a retenção compatível com os backups). Não existe argumento que pule a janela, a política ou o veredito.
 *   - interpretarArgumentos(argv) -> { ok: true, json, executar, retencaoMinutos, intervaloBackupMinutos, limite, destino } | { ok: false, erro }; o erro nunca ecoa o valor.
 *   - executarComando(opcoes, { pool, diretorio, janelaArquivo, saida, agora, fs, ganchos, tempoMaximoDaTravaMs }) -> Promise<{ saida: <código>, resultado }>. Não encerra o pool.
 *   - SAIDAS = { OK: 0, ERRO: 1, ARGUMENTOS: 2, JANELA_OCUPADA: 6, RECUSADO: 7, PARCIAL: 8 } (os códigos 3, 4 e 5 são do verificador e não se repetem aqui):
 *     0 simulação concluída (mesmo com impedimentos, que são só informados) ou execução concluída; 2 argumentos ou destino não autorizado; 6 janela ocupada (backup ou outra limpeza);
 *     7 execução recusada (política, janela não configurada ou inválida, armazenamento não confiável); 8 execução com falha(s) ao remover.
 *   - A saída nunca leva caminho absoluto, segredo nem caractere de controle vindo do disco.
 *
 * FORMATO DO TEXTO (exercitado abaixo; o JSON leva os mesmos dados, com o hash inteiro):
 *   - modo no cabeçalho ("SIMULAÇÃO" ou "EXECUÇÃO") e a linha "Banco conferido pela conexão: <nome> (oid <n>); destino autorizado confere | destino NÃO confirmado";
 *   - seções "CANDIDATOS (n)", "RETIDOS (n)", "FORA DO ESCOPO (n)", "REMOVIDOS (n)", "IGNORADOS (n)" e "FALHAS (n)", com uma linha por item: "empresa 7 · pasta <12 hex>… · TIPO" (hash abreviado);
 *   - recusa: "Recusado (CODIGO)" e "Nada foi removido"; simulação com impedimentos: "A execução seria RECUSADA: <códigos>"; simulação: "Nenhuma alteração foi feita";
 *   - fecho da execução: "removidos=N", "bytes liberados=N", "restantes=N" e "limite=N".
 *
 * ORDEM DO PROCESSO (principal, exercitada em CLO-21 a CLO-24): argumentos (saída 2) -> configuração do ambiente (saída 1; `--executar` sem janela configurada é saída 7, ainda ANTES de
 * conectar ao banco) -> conexão -> executarComando, que confere o destino (banco e OID) ANTES de ler qualquer imagem (saída 2).
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'imagens-limpar-orfaos.js');
const CLI = () => exigirModulo('scripts/imagens-limpar-orfaos');
const { AGORA, DIA } = a;
const SEGREDO = 'SEGREDO-DO-AMBIENTE-DO-TESTE-CLI-LIMPAR-7741';
const BANCO = { nome: 'gestao_epi_teste_local', oid: '16384' };
const DESTINO = { banco: BANCO.nome, oid: BANCO.oid };

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
const mundo = (opcoes = {}) => a.criarMundo(novaRaiz, { ...opcoes, bancoOpcoes: { banco: BANCO, ...(opcoes.bancoOpcoes ?? {}) } });

function capturar() {
  const linhas = [];
  const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
  return { saida: { log: guardar, error: guardar }, linhas, texto: () => linhas.join('\n') };
}

const opcoesDe = (extra = {}) => ({ json: false, executar: false, retencaoMinutos: 1500, intervaloBackupMinutos: null, limite: 50, destino: null, ...extra });
const comando = (m, extra = {}, ambiente = {}) => {
  const c = capturar();
  const chamada = CLI().executarComando(opcoesDe(extra), { pool: m.banco, diretorio: m.raiz, janelaArquivo: m.arquivoDaJanela, saida: c.saida, agora: () => AGORA, fs: m.fs, ...ambiente });
  return { chamada, c };
};
const execucao = { executar: true, intervaloBackupMinutos: 60, destino: DESTINO };

describe('[CLO] argumentos, uso e códigos de saída', () => {
  test('CLO-01 — os códigos de saída são exatamente OK=0, ERRO=1, ARGUMENTOS=2, JANELA_OCUPADA=6, RECUSADO=7, PARCIAL=8 (congelados, sem repetir 3, 4 e 5 do verificador) e a interface prevista existe', () => {
    const cli = CLI();
    assert.deepEqual(cli.SAIDAS, { OK: 0, ERRO: 1, ARGUMENTOS: 2, JANELA_OCUPADA: 6, RECUSADO: 7, PARCIAL: 8 });
    assert.equal(Object.isFrozen(cli.SAIDAS), true);
    for (const nome of ['interpretarArgumentos', 'executarComando', 'uso']) assert.equal(typeof cli[nome], 'function', nome);
  });

  test('CLO-02 — sem argumentos: tudo no padrão e SIMULAÇÃO (retenção de 1.500 min, intervalo não informado, limite 50, saída em texto, sem destino)', () => {
    assert.deepEqual(CLI().interpretarArgumentos([]), {
      ok: true, json: false, executar: false, retencaoMinutos: 1500, intervaloBackupMinutos: null, limite: 50, destino: null,
    });
  });

  test('CLO-03 — argumentos válidos, em qualquer ordem, inclusive os limites dos intervalos', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos(['--json', '--retencao-minutos', '4320', '--limite', '10']), {
      ok: true, json: true, executar: false, retencaoMinutos: 4320, intervaloBackupMinutos: null, limite: 10, destino: null,
    });
    assert.deepEqual(interpretarArgumentos(['--retencao-minutos', '1440']).retencaoMinutos, 1440);
    assert.deepEqual(interpretarArgumentos(['--retencao-minutos', '525600']).retencaoMinutos, 525600);
    assert.deepEqual(interpretarArgumentos(['--limite', '1']).limite, 1);
    assert.deepEqual(interpretarArgumentos(['--limite', '1000']).limite, 1000);
    assert.deepEqual(interpretarArgumentos(['--intervalo-backup-minutos', '1']).intervaloBackupMinutos, 1);
    assert.deepEqual(interpretarArgumentos(['--intervalo-backup-minutos', '525540']).intervaloBackupMinutos, 525540);
    const completo = interpretarArgumentos(['--banco-oid', '16384', '--executar', '--intervalo-backup-minutos', '60', '--banco-autorizado', 'gestao_epi_teste_local']);
    assert.deepEqual(completo, {
      ok: true, json: false, executar: true, retencaoMinutos: 1500, intervaloBackupMinutos: 60, limite: 50, destino: { banco: 'gestao_epi_teste_local', oid: '16384' },
    });
  });

  test('CLO-04 — argumentos inválidos têm mensagem própria e NUNCA ecoam o valor recebido', () => {
    const { interpretarArgumentos } = CLI();
    const invalidos = [
      [['--retencao-minutos'], '--retencao-minutos exige um valor'],
      [['--retencao-minutos', '--json'], '--retencao-minutos exige um valor'],
      [['--retencao-minutos', '1439'], '--retencao-minutos deve ser um inteiro de 1440 a 525600'],
      [['--retencao-minutos', '525601'], '--retencao-minutos deve ser um inteiro de 1440 a 525600'],
      [['--retencao-minutos', '1.5'], '--retencao-minutos deve ser um inteiro de 1440 a 525600'],
      [['--retencao-minutos', 'abc'], '--retencao-minutos deve ser um inteiro de 1440 a 525600'],
      [['--retencao-minutos', '-1'], '--retencao-minutos deve ser um inteiro de 1440 a 525600'],
      [['--intervalo-backup-minutos', '0'], '--intervalo-backup-minutos deve ser um inteiro de 1 a 525540'],
      [['--intervalo-backup-minutos', '525541'], '--intervalo-backup-minutos deve ser um inteiro de 1 a 525540'],
      [['--intervalo-backup-minutos', '525600'], '--intervalo-backup-minutos deve ser um inteiro de 1 a 525540'],
      [['--intervalo-backup-minutos', 'duas-horas'], '--intervalo-backup-minutos deve ser um inteiro de 1 a 525540'],
      [['--limite', '0'], '--limite deve ser um inteiro de 1 a 1000'],
      [['--limite', '1001'], '--limite deve ser um inteiro de 1 a 1000'],
      [['--limite', 'todos'], '--limite deve ser um inteiro de 1 a 1000'],
      [['--json', '--json'], '--json informado mais de uma vez'],
      [['--executar', '--executar'], '--executar informado mais de uma vez'],
      [['--limite', '5', '--limite', '6'], '--limite informado mais de uma vez'],
      [['--banco-autorizado', 'x'], '--banco-autorizado e --banco-oid devem ser informados juntos'],
      [['--banco-oid', '1'], '--banco-autorizado e --banco-oid devem ser informados juntos'],
      [['--banco-autorizado', 'a', '--banco-oid', 'nao-numerico'], '--banco-oid deve ser numérico'],
    ];
    for (const [argv, erro] of invalidos) assert.deepEqual(interpretarArgumentos(argv), { ok: false, erro }, argv.join(' '));
    assert.throws(() => interpretarArgumentos('--json'), TypeError);
  });

  test('CLO-05 — `--executar` exige o destino (banco e OID) e o intervalo entre backups, nesta ordem de verificação', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos(['--executar']), { ok: false, erro: '--executar exige --banco-autorizado e --banco-oid' });
    assert.deepEqual(interpretarArgumentos(['--executar', '--intervalo-backup-minutos', '60']), { ok: false, erro: '--executar exige --banco-autorizado e --banco-oid' });
    assert.deepEqual(interpretarArgumentos(['--executar', '--banco-autorizado', 'x', '--banco-oid', '1']), { ok: false, erro: '--executar exige --intervalo-backup-minutos' });
    assert.equal(interpretarArgumentos(['--executar', '--banco-autorizado', 'x', '--banco-oid', '1', '--intervalo-backup-minutos', '60']).ok, true);
  });

  test('CLO-06 — a simulação aceita o intervalo e o destino (para avaliar a política e conferir o banco), sem `--executar`', () => {
    const r = CLI().interpretarArgumentos(['--intervalo-backup-minutos', '120', '--banco-autorizado', 'x', '--banco-oid', '7']);
    assert.deepEqual([r.ok, r.executar, r.intervaloBackupMinutos, r.destino], [true, false, 120, { banco: 'x', oid: '7' }]);
  });

  test('CLO-07 — NÃO existe argumento que pule a janela, a política, o veredito ou a conferência do banco, nem que inclua a biblioteca padrão: todos são "argumento desconhecido"', () => {
    const { interpretarArgumentos } = CLI();
    const proibidos = [
      '--forcar', '--force', '--yes', '-y', '--sim', '--recursivo', '--todos', '--padrao', '--incluir-padrao', '--ignorar-janela', '--sem-janela', '--sem-trava', '--sem-politica',
      '--ignorar-veredito', '--ignorar-banco', '--idade-minima-minutos', '--remover', '--apagar', '--purgar', '--restaurar', 'executar', '-x',
    ];
    for (const proibido of proibidos) assert.deepEqual(interpretarArgumentos([proibido]), { ok: false, erro: 'argumento desconhecido' }, proibido);
  });

  test('CLO-08 — o uso descreve os argumentos, diz que a SIMULAÇÃO é o padrão, que executar exige destino e intervalo, e cita a variável da janela; não oferece atalhos', () => {
    const texto = CLI().uso();
    for (const trecho of ['--json', '--executar', '--retencao-minutos', '--intervalo-backup-minutos', '--limite', '--banco-autorizado', '--banco-oid', 'SIMULAÇÃO', 'IMAGENS_JANELA_ESCRITA_ARQUIVO', 'IMAGENS_ARMAZENAMENTO_DIRETORIO']) {
      assert.ok(texto.includes(trecho), trecho);
    }
    assert.doesNotMatch(texto, /--forcar|--force|--yes|--ignorar|--sem-janela|--incluir-padrao/);
  });

  test('CLO-09 — o script npm existe, roda o comando com dotenv e NENHUM script imagens:* embute `--executar`; o .env.example documenta a variável da janela só comentada e sem valor', () => {
    const base = path.join(__dirname, '..', '..');
    const pacote = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    assert.equal(pacote.scripts['imagens:limpar-orfaos'], 'node --require dotenv/config scripts/imagens-limpar-orfaos.js', 'contrato futuro: o script npm imagens:limpar-orfaos não existe');
    assert.equal(pacote.scripts['imagens:verificar'], 'node --require dotenv/config scripts/imagens-verificar.js', 'o verificador não muda');
    for (const [nome, comando_] of Object.entries(pacote.scripts)) if (nome.startsWith('imagens:')) assert.doesNotMatch(comando_, /--executar/, nome);
    const exemplo = fs.readFileSync(path.join(base, '.env.example'), 'utf8');
    assert.match(exemplo, /^#\s*IMAGENS_JANELA_ESCRITA_ARQUIVO=\s*$/m, 'contrato futuro: .env.example sem a variável IMAGENS_JANELA_ESCRITA_ARQUIVO comentada e sem valor');
    assert.doesNotMatch(exemplo, /^IMAGENS_JANELA_ESCRITA_ARQUIVO=/m, 'a variável não pode vir ativa nem com valor no exemplo');
  });
});

describe('[CLO] execução: saída, código e conteúdo', () => {
  test('CLO-10 — a SIMULAÇÃO (padrão) lista os candidatos, separa retidos e fora do escopo, afirma que nada foi alterado, termina com 0 e não toca em nada', async () => {
    const m = mundo({ orfaos: [{ semente: 'c10-a', idadeMin: 3 * DIA }, { semente: 'c10-novo', idadeMin: 5 }, { semente: 'c10-padrao', escopo: 'PADRAO', idadeMin: 3 * DIA }] });
    const antes = m.retrato();
    const { chamada, c } = comando(m);
    const { saida, resultado } = await chamada;
    const texto = c.texto();
    assert.equal(saida, 0);
    assert.equal(resultado.modo, 'SIMULACAO');
    assert.match(texto, /SIMULAÇÃO/);
    assert.match(texto, /CANDIDATOS \(1\)/);
    assert.match(texto, /RETIDOS \(1\)/);
    assert.match(texto, /FORA DO ESCOPO \(1\)/);
    assert.match(texto, /empresa 7 · pasta [0-9a-f]{12}… · ORFAO_CONJUNTO/);
    assert.match(texto, /Nenhuma alteração foi feita/);
    assert.match(texto, /Banco conferido pela conexão: gestao_epi_teste_local \(oid 16384\); destino NÃO confirmado/);
    assert.deepEqual(m.destrutivas(), []);
    assert.deepEqual(m.retrato(), antes);
  });

  test('CLO-11 — a simulação com impedimentos SAI COM 0 e diz que a execução seria recusada, e por quê', async () => {
    const m = mundo({ orfaos: [{ semente: 'c11', idadeMin: 3 * DIA }] });
    const { chamada, c } = comando(m, { retencaoMinutos: 1440, intervaloBackupMinutos: 1440 }, { janelaArquivo: undefined });
    const { saida } = await chamada;
    assert.equal(saida, 0);
    assert.match(c.texto(), /A execução seria RECUSADA: .*RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP.*JANELA_NAO_CONFIGURADA/);
  });

  test('CLO-12 — a EXECUÇÃO com destino conferido remove os candidatos, relata cada arquivo, termina com 0 e solta a janela', async () => {
    const m = mundo({ orfaos: [{ semente: 'c12-a', idadeMin: 3 * DIA }, { semente: 'c12-b', idadeMin: 4 * DIA }, { semente: 'c12-novo', idadeMin: 5 }] });
    const { chamada, c } = comando(m, execucao);
    const { saida, resultado } = await chamada;
    const texto = c.texto();
    assert.equal(saida, 0);
    assert.equal(resultado.modo, 'EXECUCAO');
    assert.match(texto, /EXECUÇÃO/);
    assert.match(texto, /destino autorizado confere/);
    assert.match(texto, /REMOVIDOS \(2\)/);
    assert.match(texto, /removidos=2/);
    assert.match(texto, /bytes liberados=1080/);
    assert.equal(m.orfaos[0].existe() || m.orfaos[1].existe(), false);
    assert.equal(m.orfaos[2].existe(), true, 'o recente fica');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.doesNotMatch(texto, /Nenhuma alteração foi feita/);
  });

  test('CLO-13 — destino que NÃO confere (nome ou OID), na simulação e na execução: saída 2, DESTINO_NAO_AUTORIZADO, só a identificação do banco foi consultada e nada foi lido, removido nem travado', async () => {
    for (const destino of [{ banco: 'outro_banco', oid: BANCO.oid }, { banco: BANCO.nome, oid: '99999' }]) {
      for (const extra of [{ destino }, { ...execucao, destino }]) {
        const m = mundo({ orfaos: [{ semente: `c13-${destino.banco}-${destino.oid}-${extra.executar}`, idadeMin: 3 * DIA }] });
        const { chamada, c } = comando(m, extra);
        const { saida, resultado } = await chamada;
        assert.equal(saida, 2);
        assert.equal(resultado, null);
        assert.match(c.texto(), /DESTINO_NAO_AUTORIZADO/);
        assert.match(c.texto(), /gestao_epi_teste_local/);
        assert.equal(m.banco.sql.length, 1, 'só a identificação do banco');
        assert.deepEqual(m.chamadas, [], 'nenhuma leitura do disco');
        assert.deepEqual(m.destrutivas(), []);
        assert.equal(m.orfaos[0].existe(), true);
        assert.equal(fs.existsSync(m.arquivoDaJanela), false);
      }
    }
  });

  test('CLO-14 — janela ocupada por um BACKUP: saída 6, o texto mostra o dono (tipo, pid e desde quando) sem caminho nem token, diz que nada foi removido, e a trava alheia não muda', async () => {
    const m = mundo({ orfaos: [{ semente: 'c14', idadeMin: 3 * DIA }] });
    const doc = a.escreverTravaAlheia(m.arquivoDaJanela, { tipo: 'BACKUP', pid: 2468 });
    const antes = fs.readFileSync(m.arquivoDaJanela);
    const { chamada, c } = comando(m, execucao);
    const { saida } = await chamada;
    const texto = c.texto();
    assert.equal(saida, 6);
    assert.match(texto, /Recusado \(JANELA_OCUPADA\)/);
    assert.match(texto, /BACKUP/);
    assert.match(texto, /2468/);
    assert.match(texto, /Nada foi removido/);
    assert.equal(texto.includes(doc.token), false);
    assert.equal(texto.includes(m.arquivoDaJanela), false);
    assert.deepEqual(fs.readFileSync(m.arquivoDaJanela), antes);
    assert.equal(m.orfaos[0].existe(), true);
  });

  test('CLO-15 — as outras recusas da execução saem com 7 e trazem o código: política (retenção ≤ intervalo), janela não configurada, janela dentro do armazenamento, armazenamento não confiável', async () => {
    const casos = [
      ['RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP', (m) => comando(m, { ...execucao, retencaoMinutos: 1441, intervaloBackupMinutos: 1441 })],
      ['JANELA_NAO_CONFIGURADA', (m) => comando(m, execucao, { janelaArquivo: undefined })],
      ['JANELA_INVALIDA', (m) => comando(m, execucao, { janelaArquivo: path.join(m.raiz, 'janela.lock') })],
      ['ARMAZENAMENTO_NAO_CONFIAVEL', (m) => { fs.writeFileSync(path.join(m.raiz, 'LEIAME.txt'), 'x'); return comando(m, execucao); }],
    ];
    for (const [codigo, preparar] of casos) {
      const m = mundo({ orfaos: [{ semente: `c15-${codigo}`, idadeMin: 3 * DIA }] });
      const { chamada, c } = preparar(m);
      const { saida, resultado } = await chamada;
      assert.equal(saida, 7, codigo);
      assert.equal(resultado.recusa.codigo, codigo);
      assert.match(c.texto(), new RegExp(`Recusado \\(${codigo}\\)`));
      assert.match(c.texto(), /Nada foi removido/);
      if (codigo === 'ARMAZENAMENTO_NAO_CONFIAVEL') assert.match(c.texto(), /imagens:verificar/, 'a recusa manda investigar com o verificador');
      assert.equal(m.orfaos[0].existe(), true, codigo);
    }
  });

  test('CLO-16 — falha ao remover um conjunto: saída 8 (PARCIAL), a falha é listada com o código do sistema, os outros conjuntos foram removidos e a janela foi solta', async () => {
    const m = mundo({ orfaos: [{ semente: 'c16-a', idadeMin: 3 * DIA }, { semente: 'c16-b', idadeMin: 3 * DIA }] });
    const [primeiro] = [...m.orfaos].sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const quebrado = a.fachadaDeLimpeza(m.raiz, { eventos: m.eventos, falhas: [{ metodo: 'unlink', ondeContem: primeiro.hash, codigo: 'EACCES' }] });
    const { chamada, c } = comando(m, execucao, { fs: quebrado.fs });
    const { saida, resultado } = await chamada;
    assert.equal(saida, 8);
    assert.equal(resultado.falhas.length, 1);
    assert.match(c.texto(), /FALHAS \(1\)/);
    assert.match(c.texto(), /EACCES/);
    assert.equal(resultado.removidos.length, 1);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
  });

  test('CLO-17 — execução sem nada a fazer termina com 0; `limite` e `restantes` aparecem na saída; o conteúdo ignorado (registro que apareceu) é listado com o motivo e não conta como falha', async () => {
    const vazio = mundo();
    assert.equal((await comando(vazio, execucao).chamada).saida, 0);

    const m = mundo({ orfaos: Array.from({ length: 4 }, (_, i) => ({ semente: `c17-${i}`, idadeMin: 3 * DIA })) });
    const [primeiroDaOrdem] = [...m.orfaos].sort((x, y) => (x.hash < y.hash ? -1 : 1));
    const { chamada, c } = comando(m, { ...execucao, limite: 3 }, { ganchos: { aposPlanejar: async () => { m.banco.registro.push(a.linhaQueCobre(primeiroDaOrdem, { id: 77 })); } } });
    const { saida, resultado } = await chamada;
    assert.equal(saida, 0, 'ignorar por registro novo não é falha');
    assert.match(c.texto(), /limite=3/);
    assert.match(c.texto(), /IGNORADOS \(1\)/);
    assert.match(c.texto(), /REGISTRO_APARECEU/);
    assert.equal(resultado.restantes, 1);
    assert.match(c.texto(), /restantes=1/);
  });

  test('CLO-18 — `--json` imprime UM documento JSON { banco, destinoConfere, relatorio } e nenhum texto a mais; o relatório leva o hash completo e o texto, só o abreviado', async () => {
    const m = mundo({ orfaos: [{ semente: 'c18', idadeMin: 3 * DIA }] });
    const { chamada, c } = comando(m, { json: true, destino: DESTINO });
    const { saida } = await chamada;
    assert.equal(saida, 0);
    assert.equal(c.linhas.length, 1);
    const documento = JSON.parse(c.linhas[0]);
    assert.deepEqual(documento.banco, BANCO);
    assert.equal(documento.destinoConfere, true);
    assert.equal(documento.relatorio.versao, 1);
    assert.equal(documento.relatorio.candidatos[0].hash, m.orfaos[0].hash);
    const texto = capturar();
    const bancoDoTexto = a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha), banco: BANCO });
    await CLI().executarComando(opcoesDe(), { pool: bancoDoTexto, diretorio: m.raiz, janelaArquivo: m.arquivoDaJanela, saida: texto.saida, agora: () => AGORA, fs: m.fs });
    assert.equal(texto.texto().includes(m.orfaos[0].hash), false, 'o texto abrevia o hash');
    assert.match(texto.texto(), new RegExp(`pasta ${m.orfaos[0].hash.slice(0, 12)}…`));
  });

  test('CLO-19 — a saída (texto e JSON) nunca leva caminho absoluto, segredo do ambiente nem caractere de controle, mesmo com nomes hostis no disco', async () => {
    const m = mundo({ orfaos: [{ semente: 'c19', idadeMin: 3 * DIA }] });
    fs.writeFileSync(path.join(m.raiz, '\u001b[2J\u001b[31mapaga-tudo'), 'x');
    fs.writeFileSync(path.join(m.raiz, 'linha1\nlinha2'), 'x');
    process.env.SEGREDO_DO_TESTE_CLI_LIMPAR = SEGREDO;
    try {
      for (const extra of [{}, { json: true }, execucao]) {
        const { chamada, c } = comando(m, extra);
        await chamada;
        const texto = c.texto();
        assert.equal(a.saidaLimpa(texto, m.raiz), true, JSON.stringify(extra));
        assert.equal(texto.includes(m.pastaDaTrava), false);
        assert.equal(texto.includes(SEGREDO), false, 'segredo na saída');
        assert.equal(texto.includes('\u001b'), false, 'o escape vindo do nome no disco não chega à saída');
        assert.equal(texto.includes('linha1\nlinha2'), false, 'um nome com quebra de linha não forja linhas na saída');
      }
    } finally {
      delete process.env.SEGREDO_DO_TESTE_CLI_LIMPAR;
    }
  });

  test('CLO-20 — o comando não encerra o pool (quem chama decide) e usa só connect e query', async () => {
    const m = mundo({ orfaos: [{ semente: 'c20', idadeMin: 3 * DIA }] });
    m.banco.end = () => { throw new Error('o comando não deve encerrar o pool'); };
    await comando(m, execucao).chamada;
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes);
  });

  test('CLO-25 — os VALORES dos argumentos chegam ao serviço: retenção e intervalo voltam no relatório, a retenção maior retém o que a padrão removeria e o limite corta a execução', async () => {
    const m = mundo({ orfaos: [{ semente: 'c25-a', idadeMin: 3 * DIA }, { semente: 'c25-b', idadeMin: 3 * DIA }] });
    const retida = (await comando(m, { retencaoMinutos: 5 * 1440, intervaloBackupMinutos: 120 }).chamada).resultado;
    assert.deepEqual([retida.retencaoMinutos, retida.intervaloBackupMinutos], [5 * 1440, 120]);
    assert.deepEqual([retida.candidatos.length, retida.retidos.length], [0, 2]);
    const limitada = (await comando(m, { ...execucao, limite: 1 }).chamada).resultado;
    assert.equal(limitada.limite, 1);
    assert.deepEqual([limitada.removidos.length, limitada.restantes], [1, 1]);
    assert.equal(m.orfaos.filter((o) => o.existe()).length, 1, 'o outro conjunto ficou para a próxima execução');
  });
});

describe('[CLO] processo real: argumentos e configuração falham ANTES de qualquer conexão', () => {
  const ambienteMinimo = { PATH: process.env.PATH };
  const rodar = (argumentos, ambiente = ambienteMinimo) => spawnSync(process.execPath, [SCRIPT, ...argumentos], { encoding: 'utf8', env: ambiente, timeout: 20000 });

  test('CLO-21 — argumento desconhecido (inclusive os que tentam pular guardas): saída 2, uso no stderr, nada no stdout', () => {
    CLI();
    for (const argumento of ['--forcar', '--sem-janela', '--incluir-padrao', '--qualquer-coisa']) {
      const r = rodar([argumento]);
      assert.equal(r.status, 2, `${argumento}: ${r.stderr}`);
      assert.match(r.stderr, /Argumentos inválidos: argumento desconhecido/);
      assert.match(r.stderr, /Uso: /);
      assert.equal(r.stdout, '');
    }
  });

  test('CLO-22 — `--executar` sem destino e intervalo: saída 2 com a mensagem, sem tentar configuração nem banco', () => {
    CLI();
    const r = rodar(['--executar']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--executar exige --banco-autorizado e --banco-oid/);
    assert.equal(r.stdout, '');
  });

  test('CLO-23 — diretório de imagens não configurado: saída 1 com o código IMAGENS_INDISPONIVEL, sem tentar o banco (nenhuma variável DB_* no ambiente)', () => {
    CLI();
    const r = rodar([]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /IMAGENS_INDISPONIVEL/);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|password|senha|autentica/i);
  });

  test('CLO-24 — `--executar` sem IMAGENS_JANELA_ESCRITA_ARQUIVO: saída 7 com JANELA_NAO_CONFIGURADA ANTES de conectar ao banco; variável inválida: saída 1 com IMAGENS_CONFIGURACAO_INVALIDA', () => {
    CLI();
    const raiz = novaRaiz();
    const argumentos = ['--executar', '--banco-autorizado', 'gestao_epi_teste_local', '--banco-oid', '16384', '--intervalo-backup-minutos', '60'];
    const semJanela = rodar(argumentos, { PATH: process.env.PATH, IMAGENS_ARMAZENAMENTO_DIRETORIO: raiz });
    assert.equal(semJanela.status, 7, semJanela.stderr);
    assert.match(semJanela.stderr, /JANELA_NAO_CONFIGURADA/);
    assert.doesNotMatch(semJanela.stderr, /ECONNREFUSED|password|senha|autentica/i);
    const invalida = rodar(argumentos, { PATH: process.env.PATH, IMAGENS_ARMAZENAMENTO_DIRETORIO: raiz, IMAGENS_JANELA_ESCRITA_ARQUIVO: 'janela-relativa.lock' });
    assert.equal(invalida.status, 1, invalida.stderr);
    assert.match(invalida.stderr, /IMAGENS_CONFIGURACAO_INVALIDA/);
    assert.equal(invalida.stderr.includes('janela-relativa.lock'), false, 'o valor da variável não é ecoado');
  });
});
