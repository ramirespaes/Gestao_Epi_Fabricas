'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const h = require('../helpers/verificacao-imagens');

/**
 * Comando `imagens:verificar` (Biblioteca de Imagens, Unidade 5C-5): INTERFACE DE LINHA DE COMANDO do verificador, SOMENTE LEITURA.
 *
 * Módulo previsto: scripts/imagens-verificar.js, na família de scripts/imagens-importar-padrao.js (Node autônomo, executado por um operador, credenciais só
 * pelo ambiente, nada de segredo em argumento nem na saída). Não existe argumento que altere, apague, restaure ou corrija: qualquer um desses é "argumento desconhecido".
 *
 *   node --require dotenv/config scripts/imagens-verificar.js [--json] [--idade-minima-minutos <n>] [--banco-autorizado <nome> --banco-oid <oid>]
 *
 *   - interpretarArgumentos(argv) -> { ok: true, json, idadeMinimaMinutos, destino: {banco, oid}|null } | { ok: false, erro }; o erro nunca ecoa o valor recebido.
 *   - executarComando(opcoes, { pool, diretorio, saida, agora }) -> Promise<{ saida: <código>, resultado }>. Não encerra o pool (de quem chama).
 *   - Códigos de saída (o PIOR veredito): OK=0 (íntegro), ERRO=1 (falha de execução), ARGUMENTOS=2 (inclui destino não autorizado), ORFAOS=3 (só sobras sem registro),
 *     RECUPERAVEL=4 (arquivo ausente com registro íntegro), INVESTIGAR=5 (divergência, estrutura estranha, leitura que falhou ou raiz inutilizável).
 *   - Com `--banco-autorizado` e `--banco-oid` (sempre juntos) o banco da conexão é conferido ANTES de qualquer leitura de imagens; sem eles o comando só informa o
 *     banco conectado. A saída nunca leva caminho absoluto, segredo, nem caractere de controle vindo do disco.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'imagens-verificar.js');
const CLI = () => exigirModulo('scripts/imagens-verificar');
const AGORA = Date.parse('2026-10-18T12:00:00.000Z');
const SEGREDO = 'SEGREDO-DO-AMBIENTE-DO-TESTE-CLI-VERIFICAR-5521';
const DIA = h.DIA_EM_MINUTOS;

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
function novaRaiz() {
  const raiz = criarRaizTemporaria();
  raizes.push(raiz);
  return raiz;
}

function capturar() {
  const linhas = [];
  const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
  return { saida: { log: guardar, error: guardar }, linhas, texto: () => linhas.join('\n') };
}

const opcoes = (extra = {}) => ({ json: false, idadeMinimaMinutos: DIA, destino: null, ...extra });
const executar = (raiz, pool, extra = {}, ambiente = {}) => {
  const c = capturar();
  const chamada = CLI().executarComando(opcoes(extra), { pool, diretorio: raiz, saida: c.saida, agora: () => AGORA, ...ambiente });
  return { chamada, c };
};

/** Raiz com um exemplo de cada classe: devolve as linhas do banco para cada veredito desejado. */
function arvore() {
  const raiz = novaRaiz();
  const integra = h.criarImagemEmpresa(raiz, { id: 1, empresaId: 7, agora: AGORA });
  const ausente = h.criarImagemEmpresa(raiz, { id: 2, empresaId: 7, agora: AGORA, ausentes: ['miniatura'] });
  const corrompida = h.criarImagemEmpresa(raiz, { id: 3, empresaId: 7, agora: AGORA });
  fs.appendFileSync(corrompida.caminho('mestre'), 'x');
  const orfaHash = h.hex64('cli-orfao');
  h.gravarNaRaiz(raiz, `7/${orfaHash}/mestre.png`, h.conteudoDe('PNG', 'cli-orfao'), { agora: AGORA, minutosAtras: 3 * DIA });
  h.gravarNaRaiz(raiz, `7/${h.hex64('cli-recente')}/mestre.png`, h.conteudoDe('PNG', 'cli-recente'), { agora: AGORA, minutosAtras: 5 });
  return { raiz, integra, ausente, corrompida, orfaHash };
}

describe('[CLI-VER] argumentos, uso e códigos de saída', () => {
  test('CLI-VER-01 — os códigos de saída são exatamente OK=0, ERRO=1, ARGUMENTOS=2, ORFAOS=3, RECUPERAVEL=4, INVESTIGAR=5 (congelados) e a interface prevista existe', () => {
    const cli = CLI();
    assert.deepEqual(cli.SAIDAS, { OK: 0, ERRO: 1, ARGUMENTOS: 2, ORFAOS: 3, RECUPERAVEL: 4, INVESTIGAR: 5 });
    assert.equal(Object.isFrozen(cli.SAIDAS), true);
    for (const nome of ['interpretarArgumentos', 'executarComando', 'uso']) assert.equal(typeof cli[nome], 'function', nome);
  });

  test('CLI-VER-02 — sem argumentos: tudo no padrão (24 horas de idade mínima, saída em texto, sem destino informado)', () => {
    assert.deepEqual(CLI().interpretarArgumentos([]), { ok: true, json: false, idadeMinimaMinutos: DIA, destino: null });
  });

  test('CLI-VER-03 — argumentos válidos, em qualquer ordem', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos(['--json']), { ok: true, json: true, idadeMinimaMinutos: DIA, destino: null });
    assert.deepEqual(interpretarArgumentos(['--idade-minima-minutos', '0']), { ok: true, json: false, idadeMinimaMinutos: 0, destino: null });
    assert.deepEqual(interpretarArgumentos(['--idade-minima-minutos', '525600']), { ok: true, json: false, idadeMinimaMinutos: 525600, destino: null });
    const completo = interpretarArgumentos(['--banco-oid', '16384', '--json', '--banco-autorizado', 'gestao_epi_teste_local', '--idade-minima-minutos', '90']);
    assert.deepEqual(completo, { ok: true, json: true, idadeMinimaMinutos: 90, destino: { banco: 'gestao_epi_teste_local', oid: '16384' } });
  });

  test('CLI-VER-04 — não existe argumento que altere, apague, restaure ou corrija: todos são "argumento desconhecido"; os demais erros nunca ecoam o valor', () => {
    const { interpretarArgumentos } = CLI();
    for (const proibido of ['--executar', '--remover', '--limpar', '--apagar', '--restaurar', '--corrigir', '--fix', '--delete', '--force', '--purgar', '-x', 'executar']) {
      assert.deepEqual(interpretarArgumentos([proibido]), { ok: false, erro: 'argumento desconhecido' }, proibido);
    }
    const invalidos = [
      [['--idade-minima-minutos'], '--idade-minima-minutos exige um valor'],
      [['--idade-minima-minutos', '--json'], '--idade-minima-minutos exige um valor'],
      [['--idade-minima-minutos', '-1'], '--idade-minima-minutos deve ser um inteiro de 0 a 525600'],
      [['--idade-minima-minutos', '1.5'], '--idade-minima-minutos deve ser um inteiro de 0 a 525600'],
      [['--idade-minima-minutos', 'abc'], '--idade-minima-minutos deve ser um inteiro de 0 a 525600'],
      [['--idade-minima-minutos', '525601'], '--idade-minima-minutos deve ser um inteiro de 0 a 525600'],
      [['--idade-minima-minutos', '10', '--idade-minima-minutos', '20'], '--idade-minima-minutos informado mais de uma vez'],
      [['--json', '--json'], '--json informado mais de uma vez'],
      [['--banco-autorizado', 'x'], '--banco-autorizado e --banco-oid devem ser informados juntos'],
      [['--banco-oid', '1'], '--banco-autorizado e --banco-oid devem ser informados juntos'],
      [['--banco-autorizado', 'a', '--banco-oid', 'nao-numerico'], '--banco-oid deve ser numérico'],
      [['--banco-autorizado', '--banco-oid', '1'], '--banco-autorizado exige um valor'],
    ];
    for (const [argv, erro] of invalidos) {
      const resultado = interpretarArgumentos(argv);
      assert.deepEqual(resultado, { ok: false, erro }, argv.join(' '));
      for (const valor of argv.filter((v) => !v.startsWith('--'))) assert.equal(resultado.erro.includes(`"${valor}"`), false);
    }
    assert.throws(() => interpretarArgumentos('--json'), TypeError);
  });

  test('CLI-VER-05 — o uso descreve os argumentos, diz que é somente leitura e não oferece escrita', () => {
    const texto = CLI().uso();
    for (const trecho of ['--json', '--idade-minima-minutos', '--banco-autorizado', '--banco-oid', 'SOMENTE LEITURA']) assert.ok(texto.includes(trecho), trecho);
    assert.doesNotMatch(texto, /--executar|--remover|--limpar|--restaurar/);
  });

  test('CLI-VER-06 — o script npm existe e roda o comando com dotenv', () => {
    const pacote = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    assert.equal(pacote.scripts['imagens:verificar'], 'node --require dotenv/config scripts/imagens-verificar.js');
    for (const [nome, comando] of Object.entries(pacote.scripts)) if (nome.startsWith('imagens:')) assert.doesNotMatch(comando, /--executar/, nome);
  });
});

describe('[CLI-VER] execução: veredito, código de saída e conteúdo da saída', () => {
  test('CLI-VER-07 — o código de saída é o do PIOR veredito: 0 íntegro, 3 só sobras, 4 recuperável, 5 investigar', async () => {
    const raiz = novaRaiz();
    const integra = h.criarImagemEmpresa(raiz, { id: 1, empresaId: 7, agora: AGORA });
    const banco = (extra = {}) => h.poolFalso({ empresa: [integra.linha], ...extra });
    assert.equal((await executar(raiz, banco()).chamada).saida, 0);

    h.gravarNaRaiz(raiz, `7/${h.hex64('sobra-cli')}/mestre.png`, h.conteudoDe('PNG', 'sobra-cli'), { agora: AGORA, minutosAtras: 2 * DIA });
    assert.equal((await executar(raiz, banco()).chamada).saida, 3);

    const faltando = h.criarImagemEmpresa(raiz, { id: 2, empresaId: 7, agora: AGORA, ausentes: ['exibicao'] });
    assert.equal((await executar(raiz, banco({ empresa: [integra.linha, faltando.linha] })).chamada).saida, 4);

    const corrompida = h.criarImagemEmpresa(raiz, { id: 3, empresaId: 7, agora: AGORA });
    fs.appendFileSync(corrompida.caminho('miniatura'), 'x');
    assert.equal((await executar(raiz, banco({ empresa: [integra.linha, faltando.linha, corrompida.linha] })).chamada).saida, 5);

    const semRaiz = await executar(path.join(raiz, 'nao-existe'), banco()).chamada;
    assert.equal(semRaiz.saida, 5, 'raiz ausente: investigar');
  });

  test('CLI-VER-08 — a saída em texto separa o que exige investigação, o que pode ser recuperado, as sobras e os recentes, e afirma que nada foi alterado', async () => {
    const { raiz, integra, ausente, corrompida } = arvore();
    const { chamada, c } = executar(raiz, h.poolFalso({ empresa: [integra.linha, ausente.linha, corrompida.linha] }));
    const { saida, resultado } = await chamada;
    const texto = c.texto();
    assert.equal(saida, 5);
    assert.equal(resultado.veredito, 'INVESTIGAR');
    assert.match(texto, /SOMENTE LEITURA/);
    assert.match(texto, /Veredito: INVESTIGAR/);
    assert.match(texto, /EXIGE INVESTIGAÇÃO \(1\)/);
    assert.match(texto, /PODE SER RECUPERADO \(1\)/);
    assert.match(texto, /SOBRAS SEM REGISTRO \(1\)/);
    assert.match(texto, /RECENTES \(1\)/);
    assert.match(texto, /empresa 7 · imagem 3 · mestre: TAMANHO_DIVERGENTE/);
    assert.match(texto, /empresa 7 · imagem 2 · miniatura: ARQUIVO_AUSENTE/);
    assert.match(texto, /Registros: padrão=0 empresa=3/);
    assert.match(texto, /Arquivos esperados=9 íntegros=7 ausentes=1 divergentes=1 não verificados=0/);
    assert.match(texto, /Nenhuma alteração foi feita/);
    assert.ok(texto.indexOf('EXIGE INVESTIGAÇÃO') < texto.indexOf('PODE SER RECUPERADO'), 'investigar vem antes de recuperar');
  });

  test('CLI-VER-09 — a saída nunca leva caminho absoluto, segredo do ambiente nem caractere de controle (nomes hostis do disco saem escapados)', async () => {
    const { raiz, integra } = arvore();
    fs.writeFileSync(path.join(raiz, '\u001b[2J\u001b[31mapaga-tudo'), 'x');
    fs.writeFileSync(path.join(raiz, 'linha1\nlinha2'), 'x');
    process.env.SEGREDO_DO_TESTE_CLI = SEGREDO;
    try {
      const { chamada, c } = executar(raiz, h.poolFalso({ empresa: [integra.linha] }));
      await chamada;
      const texto = c.texto();
      assert.equal(texto.includes(raiz), false, 'caminho absoluto na saída');
      assert.equal(texto.includes(SEGREDO), false, 'segredo na saída');
      assert.doesNotMatch(texto, /(?!\n)\p{Cc}/u, 'caractere de controle na saída');
      assert.match(texto, /u001b/, 'o nome hostil aparece escapado');
    } finally {
      delete process.env.SEGREDO_DO_TESTE_CLI;
    }
  });

  test('CLI-VER-10 — a lista impressa é limitada (40 por seção) e o excedente é contado, nunca omitido em silêncio', async () => {
    const raiz = novaRaiz();
    const linhas = [];
    for (let id = 1; id <= 45; id += 1) linhas.push(h.criarImagemEmpresa(raiz, { id, empresaId: 7, agora: AGORA, ausentes: ['miniatura'] }).linha);
    const { chamada, c } = executar(raiz, h.poolFalso({ empresa: linhas }));
    const { saida, resultado } = await chamada;
    assert.equal(saida, 4);
    assert.equal(resultado.imagens.length, 45, 'o resultado estruturado leva todos');
    assert.match(c.texto(), /PODE SER RECUPERADO \(45\)/);
    assert.equal(c.linhas.filter((l) => /ARQUIVO_AUSENTE/.test(l)).length, 40);
    assert.match(c.texto(), /\.\.\. e mais 5/);
  });

  test('CLI-VER-11 — `--json` imprime UM documento JSON (relatório e banco conferido) e nenhum texto a mais', async () => {
    const { raiz, integra, ausente } = arvore();
    const { chamada, c } = executar(raiz, h.poolFalso({ empresa: [integra.linha, ausente.linha], banco: { nome: 'gestao_epi_teste_local', oid: '16384' } }), { json: true });
    const { saida } = await chamada;
    assert.equal(saida, 4);
    assert.equal(c.linhas.length, 1);
    const documento = JSON.parse(c.linhas[0]);
    assert.deepEqual(documento.banco, { nome: 'gestao_epi_teste_local', oid: '16384' });
    assert.equal(documento.relatorio.veredito, 'RECUPERAVEL');
    assert.equal(documento.relatorio.versao, 1);
    assert.equal(c.texto().includes(raiz), false);
    assert.doesNotMatch(c.texto(), /(?!\n)\p{Cc}/u);
  });
});

describe('[CLI-VER] destino: o par banco/armazenamento é conferido ANTES de verificar', () => {
  test('CLI-VER-12 — destino informado que NÃO confere: ARGUMENTOS, nenhuma imagem é lida e a saída diz o que foi conectado', async () => {
    const { raiz, integra } = arvore();
    for (const destino of [{ banco: 'outro_banco', oid: '16384' }, { banco: 'gestao_epi_teste_local', oid: '99999' }]) {
      const banco = h.poolFalso({ empresa: [integra.linha], banco: { nome: 'gestao_epi_teste_local', oid: '16384' } });
      const { chamada, c } = executar(raiz, banco, { destino });
      const { saida, resultado } = await chamada;
      assert.equal(saida, 2);
      assert.equal(resultado, null);
      assert.match(c.texto(), /DESTINO_NAO_AUTORIZADO/);
      assert.match(c.texto(), /gestao_epi_teste_local/);
      assert.equal(banco.sql.some((s) => /FROM imagens_(padrao|empresa)/i.test(s)), false, 'nenhuma imagem foi lida');
      assert.equal(banco.sql.length, 1, 'só a identificação do banco');
    }
  });

  test('CLI-VER-13 — destino que confere segue para a verificação e a saída registra a conferência; sem destino, informa que o banco NÃO foi confirmado', async () => {
    const { raiz, integra } = arvore();
    const dados = { empresa: [integra.linha], banco: { nome: 'gestao_epi_teste_local', oid: '16384' } };
    const confere = executar(raiz, h.poolFalso(dados), { destino: { banco: 'gestao_epi_teste_local', oid: '16384' } });
    await confere.chamada;
    assert.match(confere.c.texto(), /Banco conferido pela conexão: gestao_epi_teste_local \(oid 16384\)/);
    assert.match(confere.c.texto(), /destino autorizado confere/);

    const sem = executar(raiz, h.poolFalso(dados));
    await sem.chamada;
    assert.match(sem.c.texto(), /Banco conferido pela conexão: gestao_epi_teste_local \(oid 16384\)/);
    assert.match(sem.c.texto(), /destino NÃO confirmado/);
  });

  test('CLI-VER-14 — o comando não encerra o pool (quem chama decide) e não usa outro método além de connect e query', async () => {
    const { raiz, integra } = arvore();
    const banco = h.poolFalso({ empresa: [integra.linha] });
    banco.end = () => { throw new Error('o comando não deve encerrar o pool'); };
    await executar(raiz, banco).chamada;
  });
});

describe('[CLI-VER] processo real: argumentos e configuração falham ANTES de qualquer conexão', () => {
  const ambienteMinimo = { PATH: process.env.PATH };
  const rodar = (argumentos, ambiente = ambienteMinimo) => spawnSync(process.execPath, [SCRIPT, ...argumentos], { encoding: 'utf8', env: ambiente, timeout: 20000 });

  test('CLI-VER-15 — argumento desconhecido (inclusive os de escrita): saída 2, uso no stderr, nada no stdout', () => {
    for (const argumento of ['--executar', '--remover', '--restaurar', '--qualquer-coisa']) {
      const r = rodar([argumento]);
      assert.equal(r.status, 2, `${argumento}: ${r.stderr}`);
      assert.match(r.stderr, /Argumentos inválidos: argumento desconhecido/);
      assert.match(r.stderr, /Uso: /);
      assert.equal(r.stdout, '');
    }
  });

  test('CLI-VER-16 — diretório de imagens não configurado: saída 1 com o código IMAGENS_INDISPONIVEL, sem tentar o banco (nenhuma variável DB_* no ambiente)', () => {
    const r = rodar([]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /IMAGENS_INDISPONIVEL/);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|password|senha|autentica/i);
  });
});
