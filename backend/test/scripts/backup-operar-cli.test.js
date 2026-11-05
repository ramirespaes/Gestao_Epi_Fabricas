'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removerTemporarioSeguro, criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');
const { montarAmbiente, instantaneo, SEGREDO_NO_ARQUIVO } = require('../helpers/ambiente-verificacao-backup');
const cli = require('../../scripts/backup-operar');

/**
 * G-A (D-ORF-6): CLI do executor do backup. Um único modo, --verificar, somente leitura. Argumentos, mapeamento de veredito para código de saída,
 * saída sem vazamento e, em processo REAL, a prova de que nada é escrito, criado, conectado ou executado (pré-carregamento que faz qualquer efeito lançar).
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'backup-operar.js');
const BLOQUEADOR = path.join(__dirname, '..', 'helpers', 'bloquear-efeitos.js');
const { SAIDAS } = cli;

const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); });
function novo() { const m = montarAmbiente(); raizes.push(m.raiz); return m; }
function rodarReal(argumentos, env, extras = {}) {
  const r = spawnSync(process.execPath, [...(extras.bloqueado ? ['--require', BLOQUEADOR] : []), SCRIPT, ...argumentos], {
    cwd: extras.cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
async function rodarInjetado(argv, ambiente, raizDoCodigo, portas) {
  let saida = '';
  let erro = '';
  const codigo = await cli.executarComando({ argv, ambiente, raizDoCodigo, escrever: (t) => { saida += t; }, erro: (t) => { erro += t; }, portas });
  return { codigo, saida, erro };
}

describe('[CLI] argumentos', () => {
  test('CLI-01 — só --verificar [--json]; qualquer outro modo ou repetição é recusado sem eco do argumento', () => {
    assert.deepEqual(cli.interpretarArgumentos(['--verificar']), { ok: true, json: false });
    assert.deepEqual(cli.interpretarArgumentos(['--json', '--verificar']), { ok: true, json: true });
    for (const ruim of [[], ['--json'], ['--executar'], ['--ensaio'], ['--operacional'], ['--verificar', '--verificar'], ['--verificar', '--json', '--json'], ['verificar'], ['--verificar', '--x-segredo-ficticio']]) {
      const r = cli.interpretarArgumentos(ruim);
      assert.equal(r.ok, false, JSON.stringify(ruim));
      assert.equal(JSON.stringify(r).includes('segredo-ficticio'), false);
    }
    assert.throws(() => cli.interpretarArgumentos('--verificar'), TypeError);
  });

  test('CLI-02 — processo real: argumento inválido sai com 2, usa só stderr e não cria nada', () => {
    for (const argumentos of [[], ['--executar'], ['--ensaio'], ['--verificar', '--verificar']]) {
      const r = rodarReal(argumentos, {});
      assert.equal(r.status, SAIDAS.ARGUMENTOS, JSON.stringify(argumentos));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /Uso: node scripts\/backup-operar\.js --verificar/);
      assert.match(r.stderr, /não existem nesta versão/);
    }
  });
});

describe('[CLI] veredito e código de saída', () => {
  test('CLI-10 — ambiente completo: código 0, texto com PRONTIDAO_OPERACIONAL=NAO, nada vaza e nada é criado', async () => {
    const m = novo();
    const antes = instantaneo(m.raiz);
    const r = await rodarInjetado(['--verificar'], m.ambiente, m.caminhos.codigo);
    assert.equal(r.codigo, SAIDAS.OK, r.saida + r.erro);
    assert.equal(instantaneo(m.raiz), antes);
    assert.match(r.saida, /VEREDITO: INFRA_OK_OPERACIONAL_BLOQUEADO/);
    assert.match(r.saida, /PRONTIDAO_OPERACIONAL=NAO/);
    assert.match(r.saida, /\[PENDENTE\] PROVEDORES_DE_CIFRA\s+LISTA_VAZIA/);
    for (const valor of ['usuario_ficticio', 'banco_ficticio', SEGREDO_NO_ARQUIVO]) assert.equal(r.saida.includes(valor), false, `vazou ${valor}`);
  });

  test('CLI-11 — pendência de infraestrutura: código 3; falha: código 1; ambos com prontidão falsa', async () => {
    const m = novo();
    const pendente = await rodarInjetado(['--verificar', '--json'], { ...m.ambiente, PGPASSFILE: undefined }, m.caminhos.codigo);
    assert.equal(pendente.codigo, SAIDAS.INFRA_PENDENTE);
    const doc = JSON.parse(pendente.saida);
    assert.equal(doc.veredito, 'INFRA_PENDENTE');
    assert.equal(doc.prontidaoOperacional, false);
    fs.chmodSync(m.caminhos.subdiretorios.dumps, 0o755);
    const falha = await rodarInjetado(['--verificar', '--json'], m.ambiente, m.caminhos.codigo);
    assert.equal(falha.codigo, SAIDAS.FALHA);
    assert.equal(JSON.parse(falha.saida).veredito, 'FALHA');
  });

  test('CLI-12 — erro inesperado do diagnóstico vira código 1 com mensagem fixa, sem detalhe', async () => {
    const m = novo();
    const r = await rodarInjetado(['--verificar'], m.ambiente, m.caminhos.codigo, { statfs: () => { throw new Error('detalhe-interno-secreto'); }, lstat: () => { throw new TypeError('boom-secreto'); } });
    assert.equal(r.erro.includes('secreto'), false);
    assert.equal(r.saida.includes('secreto'), false);
    assert.ok([SAIDAS.FALHA, SAIDAS.INFRA_PENDENTE].includes(r.codigo));
  });
});

describe('[CLI-REAL] processo real sem nenhum efeito', () => {
  test('CLI-20 — controle do bloqueador: escrita, criação de processo e conexão lançam EFEITO_PROIBIDO; leitura continua permitida', () => {
    const m = novo();
    const alvo = path.join(m.raiz, 'nao-pode-existir');
    const codigo = [
      "const fs = require('node:fs'); const cp = require('node:child_process'); const net = require('node:net'); const saidas = [];",
      "const tentar = (nome, f) => { try { f(); saidas.push(nome + ':PERMITIDO'); } catch (e) { saidas.push(nome + ':' + e.code); } };",
      `tentar('escrita', () => fs.writeFileSync(${JSON.stringify(alvo)}, 'x'));`,
      `tentar('abrir-escrita', () => fs.openSync(${JSON.stringify(alvo)}, 'w'));`,
      `tentar('criar-exclusivo', () => fs.openSync(${JSON.stringify(alvo)}, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));`,
      `tentar('mkdir', () => fs.mkdirSync(${JSON.stringify(alvo)}));`,
      "tentar('processo', () => cp.spawnSync('true'));",
      "tentar('conexao', () => net.connect({ port: 1, host: '127.0.0.1' }));",
      `tentar('leitura', () => { fs.readdirSync(${JSON.stringify(m.raiz)}); fs.closeSync(fs.openSync(${JSON.stringify(m.caminhos.senha)}, 'r')); });`,
      `tentar('leitura-sem-seguir-link', () => fs.closeSync(fs.openSync(${JSON.stringify(m.caminhos.senha)}, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)));`,
      "console.log(saidas.join(' '));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['--require', BLOQUEADOR, '-e', codigo], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'escrita:EFEITO_PROIBIDO abrir-escrita:EFEITO_PROIBIDO criar-exclusivo:EFEITO_PROIBIDO mkdir:EFEITO_PROIBIDO processo:EFEITO_PROIBIDO conexao:EFEITO_PROIBIDO leitura:PERMITIDO leitura-sem-seguir-link:PERMITIDO');
    assert.equal(fs.existsSync(alvo), false);
  });

  test('CLI-21 — ambiente completo sob o bloqueador: o diagnóstico conclui (código 0), não dispara nenhum efeito e nada muda em disco', () => {
    const m = novo();
    const antes = instantaneo(m.raiz);
    const r = rodarReal(['--verificar', '--json'], m.ambiente, { bloqueado: true });
    assert.equal(r.status, SAIDAS.OK, `${r.stdout}\n${r.stderr}`);
    assert.equal(r.stderr, '');
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.veredito, 'INFRA_OK_OPERACIONAL_BLOQUEADO');
    assert.equal(doc.prontidaoOperacional, false);
    assert.equal(instantaneo(m.raiz), antes);
    assert.equal(fs.existsSync(m.caminhos.arquivoDaJanela), false);
  });

  test('CLI-22 — ambiente vazio sob o bloqueador: conclui sem efeito; pendências de infraestrutura dão código 3 (ou 1 se o PostgreSQL 16 não estiver no caminho padrão)', () => {
    const r = rodarReal(['--verificar', '--json'], {}, { bloqueado: true });
    assert.ok([SAIDAS.INFRA_PENDENTE, SAIDAS.FALHA].includes(r.status), `${r.status} ${r.stderr}`);
    assert.equal(r.stderr, '');
    assert.equal(JSON.parse(r.stdout).prontidaoOperacional, false);
  });

  test('CLI-23 — o script não carrega o .env da API: um .env no diretório de trabalho é ignorado', () => {
    const m = novo();
    const trabalho = criarRaizTemporaria();
    raizes.push(trabalho);
    fs.writeFileSync(path.join(trabalho, '.env'), `IMAGENS_ARMAZENAMENTO_DIRETORIO=${m.caminhos.imagens}\nBACKUP_RAIZ=${m.caminhos.backup}\n`, { mode: 0o600 });
    const r = rodarReal(['--verificar', '--json'], { BACKUP_PG_BINARIOS: m.caminhos.binarios }, { cwd: trabalho, bloqueado: true });
    const doc = JSON.parse(r.stdout);
    const por = Object.fromEntries(doc.itens.map((i) => [i.id, `${i.estado}:${i.codigo}`]));
    assert.equal(por.DIRETORIO_IMAGENS, 'PENDENTE:VARIAVEL_AUSENTE');
    assert.equal(por.BACKUP_RAIZ, 'PENDENTE:VARIAVEL_AUSENTE');
  });

  test('CLI-24 — saída em texto sob o bloqueador não contém caractere de controle e termina sempre com PRONTIDAO_OPERACIONAL=NAO', () => {
    const m = novo();
    const r = rodarReal(['--verificar'], m.ambiente, { bloqueado: true });
    assert.equal(r.status, SAIDAS.OK, r.stderr);
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.stdout), false);
    assert.equal(r.stdout.trim().split('\n').pop(), 'PRONTIDAO_OPERACIONAL=NAO');
  });
});
