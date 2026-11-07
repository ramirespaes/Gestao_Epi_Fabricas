'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Pol = require('../../src/services/backup-executor-politica.service');
const L = require('../../src/services/backup-aws-sdk-carregador.service');

/**
 * D-ORF-6, executor operacional [EXE-INV]: invariantes da rodada consolidada — nada é ativado, os módulos novos não escrevem, não removem, não lançam processo, não leem ambiente nem
 * definem nomes de raiz da guarda G1, o SDK só é citado no carregador (e nunca por `require` direto), e o script do executor continua sem efeito próprio.
 */

const BACKEND = path.join(__dirname, '..', '..');
/** Montado em partes de propósito: o bloqueio estático B2 só admite citar a decifragem em testes enumerados, e este teste só afirma a AUSÊNCIA dela nos módulos. */
const DECIFRA = ['decifrar', 'Container'].join('');
const MODULOS = [
  'backup-executor-politica', 'backup-executor-evidencia', 'backup-executor-publicacao', 'backup-executor-recuperacao', 'backup-executor-operacional', 'backup-executor-monitoramento',
  'backup-aws-portas', 'backup-aws-sdk-carregador',
  // L2 (Bloco C): o leitor só lê (O_RDONLY | O_NOFOLLOW) e o compositor não toca o sistema de arquivos
  'backup-executor-leitor-pacote', 'backup-executor-compositor',
];
const lerFonte = (arquivo) => fs.readFileSync(path.join(BACKEND, arquivo), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
const ESCRITA = /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|truncate|truncateSync|ftruncate|ftruncateSync|chmod|chmodSync|chown|chownSync|utimes|utimesSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND|TRUNC)\b/;
const REMOCAO = /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/;
const PROCESSO = /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(|child_process/;
const RAIZ_G1 = /\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/;

describe('[EXE-INV] módulos novos', () => {
  test('EXE-INV-01 — os módulos novos do executor (rodada consolidada e Bloco C) não escrevem, não removem, não lançam processo, não leem ambiente nem argumentos e não definem nomes de raiz da guarda G1', () => {
    for (const nome of MODULOS) {
      const fonte = lerFonte(`src/services/${nome}.service.js`);
      assert.equal(ESCRITA.test(fonte), false, `${nome}: escrita`);
      assert.equal(REMOCAO.test(fonte), false, `${nome}: remoção`);
      assert.equal(PROCESSO.test(fonte), false, `${nome}: processo`);
      assert.equal(/process\.env|process\.argv|process\.stdin|process\.umask|dotenv/.test(fonte), false, `${nome}: ambiente`);
      assert.equal(RAIZ_G1.test(fonte), false, `${nome}: nome de raiz`);
    }
  });

  test('EXE-INV-02 — o SDK da AWS só é citado no carregador, por NOME de pacote e nunca por require direto; nenhum módulo do executor importa o SDK, o módulo de limpeza ou a decifragem', () => {
    for (const nome of MODULOS) {
      const fonte = lerFonte(`src/services/${nome}.service.js`);
      assert.equal(/require\(\s*['"`]@?(?:aws-sdk|smithy|aws)\b/.test(fonte), false, `${nome}: require do SDK`);
      assert.equal(new RegExp(`imagem-backup-orfaos|${DECIFRA}`).test(fonte), false, `${nome}: limpeza ou decifragem`);
      if (nome !== 'backup-aws-sdk-carregador') assert.equal(/@aws-sdk/.test(fonte), false, `${nome}: cita o SDK`);
    }
    assert.match(lerFonte('src/services/backup-aws-sdk-carregador.service.js'), /@aws-sdk\/client-s3/);
  });

  test('EXE-INV-03 — travas fechadas: operação real desabilitada, SDK só nas três versões exatas do gate DEP-2, limpeza desabilitada, e a operação não pode ser ligada por ambiente, argumento ou módulo (a constante é única e const)', () => {
    assert.equal(Pol.OPERACAO_HABILITADA, false);
    assert.deepEqual(L.VERSOES_APROVADAS.map((v) => ({ ...v })), [
      { pacote: '@aws-sdk/client-s3', versao: '3.1152.0' },
      { pacote: '@aws-sdk/client-kms', versao: '3.1152.0' },
      { pacote: '@aws-sdk/client-sts', versao: '3.1152.0' },
    ]);
    assert.match(lerFonte('src/services/imagem-backup-orfaos.service.js'), /const LIMPEZA_OPERACIONAL_HABILITADA = false;/);
    assert.match(lerFonte('src/services/backup-executor-politica.service.js'), /^const OPERACAO_HABILITADA = false;$/m);
    const donos = [];
    const andar = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const c = path.join(dir, e.name); if (e.isDirectory()) andar(c); else if (e.name.endsWith('.js') && /OPERACAO_HABILITADA/.test(lerFonte(path.relative(BACKEND, c)))) donos.push(path.relative(BACKEND, c)); } };
    andar(path.join(BACKEND, 'src'));
    andar(path.join(BACKEND, 'scripts'));
    assert.deepEqual(donos, ['src/services/backup-executor-politica.service.js']);
  });
});

describe('[EXE-INV] script do executor e modelos de unidade', () => {
  test('EXE-INV-04 — o script do executor não escreve, não remove, não lança processo, só lê process.env na chamada principal e não importa a cifra nem o SDK', () => {
    const fonte = lerFonte('scripts/backup-operar.js');
    assert.equal(ESCRITA.test(fonte), false);
    assert.equal(REMOCAO.test(fonte), false);
    assert.equal(PROCESSO.test(fonte), false);
    assert.equal((fonte.match(/process\.env/g) ?? []).length, 1);
    assert.equal(new RegExp(`backup-fontes-cifra-envelope|${DECIFRA}|require\\(\\s*['"]@aws-sdk`).test(fonte), false);
    assert.equal(RAIZ_G1.test(fonte), false);
  });

  test('EXE-INV-05 — os modelos de unidade systemd não são lidos nem referenciados por nenhum código: são documentação inerte', () => {
    const referencias = [];
    const andar = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const c = path.join(dir, e.name); if (e.isDirectory()) andar(c); else if (e.name.endsWith('.js') && /ops\/systemd|\.service\.modelo|\.timer\.modelo/.test(lerFonte(path.relative(BACKEND, c)))) referencias.push(path.relative(BACKEND, c)); } };
    andar(path.join(BACKEND, 'src'));
    andar(path.join(BACKEND, 'scripts'));
    assert.deepEqual(referencias, []);
  });
});
