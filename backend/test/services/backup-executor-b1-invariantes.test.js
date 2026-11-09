'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * D-ORF-6, Rodada B (B1) [B1-INV]: invariantes de segurança dos módulos novos e do CLI. Leitura estática do código-fonte (sem executar nada): nenhum efeito de escrita, remoção ou processo,
 * nenhuma leitura direta do ambiente, a trava de operação única e falsa, as quatro listas operacionais vazias e a injeção dos colaboradores só por quem chama em processo.
 */

const RAIZ = path.join(__dirname, '..', '..');
const NOVOS = Object.freeze([
  'src/services/backup-executor-configuracao.service.js',
  'src/services/backup-executor-credenciais-arquivo.service.js',
  'src/services/backup-executor-ligacao-cli.service.js',
]);
const CLI = 'scripts/backup-operar.js';
const ler = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const arvore = (dir) => fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arvore(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const RE_ESCRITA = /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND|TRUNC|EXCL)\b/;
const RE_REMOCAO = /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/;
const RE_PROCESSO = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/;

describe('[B1-INV] invariantes do B1', () => {
  test('B1-INV-01 — os módulos novos e o CLI não escrevem, não removem, não criam processo e não abrem rede', () => {
    for (const arquivo of [...NOVOS, CLI]) {
      const codigo = semComentarios(ler(arquivo));
      assert.ok(!RE_ESCRITA.test(codigo), `${arquivo}: sinal de escrita`);
      assert.ok(!RE_REMOCAO.test(codigo), `${arquivo}: sinal de remoção`);
      assert.ok(!RE_PROCESSO.test(codigo), `${arquivo}: sinal de processo filho`);
      assert.ok(!/require\(\s*['"]node:(?:net|http|https|dgram|tls|child_process)['"]\s*\)/.test(codigo), `${arquivo}: rede ou processo`);
    }
  });

  test('B1-INV-02 — os módulos novos não leem o ambiente do processo: tudo chega por parâmetro; a abertura de arquivo é só de leitura sem seguir link', () => {
    for (const arquivo of NOVOS) {
      const codigo = semComentarios(ler(arquivo));
      assert.ok(!/process\.env/.test(codigo), `${arquivo}: leitura direta de process.env`);
      assert.ok(!/dotenv/.test(codigo), `${arquivo}: dotenv`);
    }
    const leitor = semComentarios(ler(NOVOS[0]));
    assert.match(leitor, /O_RDONLY \| fs\.constants\.O_NOFOLLOW \| fs\.constants\.O_NONBLOCK/);
    assert.equal((leitor.match(/fs\.openSync\(/g) ?? []).length, 1);
  });

  test('B1-INV-03 — a trava de operação e a de limpeza real têm uma única declaração, falsa', () => {
    const declaracoes = (nome) => arvore('src').concat(arvore('scripts')).flatMap((a) => (semComentarios(ler(a)).match(new RegExp(`\\bconst ${nome}\\s*=\\s*[^;]+;`, 'g')) ?? []).map((d) => `${a}: ${d}`));
    assert.deepEqual(declaracoes('OPERACAO_HABILITADA'), ['src/services/backup-executor-politica.service.js: const OPERACAO_HABILITADA = false;']);
    assert.deepEqual(declaracoes('LIMPEZA_OPERACIONAL_HABILITADA'), ['src/services/imagem-backup-orfaos.service.js: const LIMPEZA_OPERACIONAL_HABILITADA = false;']);
    for (const arquivo of [...NOVOS, CLI]) assert.ok(!/OPERACAO_HABILITADA\s*=/.test(semComentarios(ler(arquivo))), `${arquivo}: não pode atribuir a trava`);
  });

  test('B1-INV-04 — as quatro listas operacionais seguem vazias', () => {
    const { DESTINOS_AUTORIZADOS } = require('../../src/services/imagem-backup-destinos.service');
    const { ARMAZENAMENTOS_DURAVEIS_APROVADOS } = require('../../src/services/imagem-backup-durabilidade.service');
    const { PROVEDORES_OPERACIONAIS_APROVADOS } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
    const { PROVEDORES_DE_CIFRA_APROVADOS } = require('../../src/services/backup-fontes-cifra-envelope.service');
    assert.deepEqual({ ...DESTINOS_AUTORIZADOS }, { HOMOLOGACAO: [], PRODUCAO: [] });
    assert.deepEqual([...ARMAZENAMENTOS_DURAVEIS_APROVADOS], []);
    assert.deepEqual([...PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.deepEqual([...PROVEDORES_DE_CIFRA_APROVADOS], []);
    assert.equal(require('../../src/services/backup-executor-politica.service').OPERACAO_HABILITADA, false);
  });

  test('B1-INV-05 — o CLI real nunca injeta colaboradores nem portas: a única entrada da montagem é o montarPortas do require.main', () => {
    const cli = semComentarios(ler(CLI));
    assert.ok(!/colaboradores/.test(cli), 'o CLI não pode conhecer os colaboradores');
    assert.equal((cli.match(/montarPortasDoCli\(/g) ?? []).length, 1);
    assert.equal((cli.match(/require\.main === module/g) ?? []).length, 1);
    const principal = cli.slice(cli.indexOf('require.main === module'));
    assert.ok(principal.includes('montarPortas:') && principal.includes('montarPortasDoCli('), 'a injeção fica dentro de require.main');
    assert.ok(!/\bportas\s*:/.test(principal), 'require.main não passa portas prontas');
  });

  test('B1-INV-06 — nenhum outro código de produção conhece os colaboradores da montagem nem monta a ligação do CLI', () => {
    const referencias = arvore('src').concat(arvore('scripts')).filter((a) => a.endsWith('.js'))
      .filter((a) => /\bcolaboradores\b/.test(semComentarios(ler(a))) || /montarPortasDoCli/.test(semComentarios(ler(a))));
    assert.deepEqual(referencias.sort(), [CLI, NOVOS[2]].sort());
  });

  test('B1-INV-07 — as exportações dos módulos novos são exatamente as previstas', () => {
    assert.deepEqual(Object.keys(require('../../src/services/backup-executor-configuracao.service')).sort(), ['CODIGOS', 'LIMITE_CONFIGURACAO_BYTES', 'VARIAVEL', 'lerArquivoRestrito', 'lerConfiguracaoOperacional']);
    assert.deepEqual(Object.keys(require('../../src/services/backup-executor-credenciais-arquivo.service')).sort(), ['LIMITE_ARQUIVO_BYTES', 'criarFornecedoresPorArquivo']);
    assert.deepEqual(Object.keys(require('../../src/services/backup-executor-ligacao-cli.service')).sort(), ['LIMITE_RECIBO_BYTES', 'montarPortasDoCli']);
  });

  test('B1-INV-08 — o B1 não depende de pacote novo: os módulos novos só requerem módulos internos do Node e arquivos do próprio projeto', () => {
    for (const arquivo of NOVOS) {
      const requeridos = [...semComentarios(ler(arquivo)).matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
      assert.ok(requeridos.every((r) => r.startsWith('node:') || r.startsWith('./') || r.startsWith('../')), `${arquivo}: ${requeridos.join(',')}`);
    }
  });
});
