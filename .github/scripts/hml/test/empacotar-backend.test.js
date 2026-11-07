'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Empacotador do backend por allowlist explícita (deploy/hml). O pacote leva só
 * src/, scripts/, migrations/ e três arquivos de raiz; nunca testes, docs, .env,
 * node_modules ou segredos. Tudo é fail-closed: qualquer dúvida recusa o pacote
 * inteiro antes de escrever, e nenhuma mensagem de erro repete o valor suspeito.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MODULO = path.join(REPO, 'deploy', 'hml', 'empacotar-backend.js');
const BACKEND_REAL = path.join(REPO, 'backend');
const COMMIT = 'd'.repeat(40);
const ROTULO = 'hml-20261104T101500-ddddddd';
const temporarios = [];

function carregar() {
  try {
    return require(MODULO);
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && /empacotar-backend/.test(erro.message)) {
      assert.fail('empacotador do backend ausente: deploy/hml/empacotar-backend.js ainda não existe (RED esperado)');
    }
    throw erro;
  }
}
function novoDiretorio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-backend-'));
  temporarios.push(dir);
  return dir;
}
const sha256 = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');
function listar(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? listar(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  }).sort();
}
function recusa(fn, codigo) {
  assert.throws(fn, (erro) => {
    assert.equal(erro.codigo, codigo, `esperado ${codigo}, veio ${erro.codigo}: ${erro.message}`);
    return true;
  });
  return null;
}
function recusaCom(fn, codigo) {
  let capturado;
  assert.throws(fn, (erro) => { capturado = erro; return true; });
  assert.equal(capturado.codigo, codigo, `esperado ${codigo}, veio ${capturado.codigo}: ${capturado.message}`);
  return capturado;
}

const LOCK_VALIDO = () => ({
  name: 'x',
  lockfileVersion: 3,
  packages: {
    '': { name: 'x', version: '1.0.0' },
    'node_modules/zod': { version: '4.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz', integrity: 'sha512-AAAA' },
  },
});
const PACKAGE_VALIDO = () => ({ name: 'x', version: '1.0.0', engines: { node: '>=22' }, scripts: { start: 'node src/server.js' }, dependencies: { zod: '^4.0.0' } });

// Backend sintético com a forma do real. `mudancas`: caminho -> conteúdo (string/Buffer) ou null para remover.
function criarRaiz(mudancas = {}) {
  const raiz = novoDiretorio();
  const base = {
    'package.json': JSON.stringify(PACKAGE_VALIDO()),
    'package-lock.json': JSON.stringify(LOCK_VALIDO()),
    'src/server.js': "'use strict';\nrequire('./app');\n",
    'src/app.js': "'use strict';\nmodule.exports = {};\n",
    'src/email/assets/marca.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'scripts/guarda-inicializacao.js': "'use strict';\n",
    'migrations/000_a.sql': 'CREATE TABLE a (id int);\n',
    'migrations/001_b.sql': 'CREATE TABLE b (id int);\n',
    'test/app.test.js': 'x',
    'docs/leia.md': 'x',
    '.env.example': 'PORT=3000\n',
    '.gitignore': '.env\n',
    'node_modules/zod/index.js': 'x',
    'coverage/lcov.info': 'x',
  };
  const arquivos = { ...base, ...mudancas };
  if (!('migrations/checksums.json' in mudancas)) {
    const migrations = {};
    for (const [rel, conteudo] of Object.entries(arquivos)) {
      if (conteudo !== null && /^migrations\/[^/]+\.sql$/.test(rel)) migrations[path.basename(rel)] = sha256(conteudo);
    }
    arquivos['migrations/checksums.json'] = JSON.stringify({ algoritmo: 'sha256', migrations });
  }
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    if (conteudo === null) continue;
    fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true });
    fs.writeFileSync(path.join(raiz, rel), conteudo);
  }
  return raiz;
}
const EMPACOTADOS_SINTETICOS = [
  'migrations/000_a.sql', 'migrations/001_b.sql', 'migrations/checksums.json', 'package-lock.json', 'package.json',
  'scripts/guarda-inicializacao.js', 'src/app.js', 'src/email/assets/marca.png', 'src/server.js',
];

afterEach(() => {
  while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true });
});

describe('backend real: fatos que o empacotador assume', () => {
  test('o backend versionado cumpre as regras: lockfile v3 com origem npm e integridade, sem hooks de instalação, engines >= 22', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(BACKEND_REAL, 'package-lock.json'), 'utf8'));
    assert.equal(lock.lockfileVersion, 3);
    for (const [nome, pacote] of Object.entries(lock.packages)) {
      if (!nome) continue;
      assert.match(pacote.resolved, /^https:\/\/registry\.npmjs\.org\//, nome);
      assert.ok(pacote.integrity, nome);
    }
    const pacote = JSON.parse(fs.readFileSync(path.join(BACKEND_REAL, 'package.json'), 'utf8'));
    for (const gancho of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) assert.equal(pacote.scripts?.[gancho], undefined, gancho);
    assert.match(pacote.engines.node, />=\s*22/);
  });
});

describe('empacotar-backend — allowlist e pacote', () => {
  test('a allowlist é um arquivo próprio e fixa raízes, extensões e arquivos de raiz', () => {
    const { lerAllowlist } = carregar();
    const a = lerAllowlist();
    assert.deepEqual(a.arquivos.slice().sort(), ['migrations/checksums.json', 'package-lock.json', 'package.json']);
    assert.deepEqual(a.raizes.map((r) => `${r.prefixo}|${r.extensoes.join(',')}`).sort(),
      ['migrations/|.sql', 'scripts/|.js', 'src/email/assets/|.png', 'src/|.js']);
  });

  test('o módulo é independente: não importa os empacotadores do Portal e do Painel', () => {
    carregar();
    assert.doesNotMatch(fs.readFileSync(MODULO, 'utf8'), /require\(\s*['"][^'"]*(?:publicacao|frontend)[^'"]*['"]\s*\)/);
  });

  test('o backend real é empacotado e o conteúdo é exatamente o que o Git rastreia nas raízes permitidas', () => {
    const { empacotarBackend } = carregar();
    const saida = path.join(novoDiretorio(), 'pacote');
    const r = empacotarBackend({ saida });
    const git = spawnSync('git', ['ls-files', '--', 'backend'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    const esperado = git.stdout.split('\n').filter(Boolean).map((f) => f.replace(/^backend\//, ''))
      .filter((f) => /^(src|scripts|migrations)\//.test(f) || ['package.json', 'package-lock.json'].includes(f))
      .sort();
    assert.deepEqual(listar(saida), esperado);
    assert.deepEqual(r.arquivos, esperado);
    for (const fora of ['.env.example', '.gitignore']) assert.ok(!r.arquivos.includes(fora), fora);
    assert.ok(!r.arquivos.some((f) => /^(test|docs|node_modules|coverage)\//.test(f)));
    for (const rel of ['src/server.js', 'src/app.js', 'migrations/checksums.json', 'scripts/guarda-inicializacao.js', 'src/email/assets/marca-safework.png']) assert.ok(r.arquivos.includes(rel), rel);
    for (const rel of esperado) assert.equal(r.manifesto[rel], sha256(fs.readFileSync(path.join(BACKEND_REAL, rel))), rel);
  });

  test('pacote sintético: bytes idênticos, manifesto SHA-256 por arquivo, migrations e hash do lockfile', () => {
    const { empacotarBackend } = carregar();
    const raiz = criarRaiz();
    const saida = path.join(novoDiretorio(), 'pacote');
    const r = empacotarBackend({ saida, raiz });
    assert.deepEqual(listar(saida), EMPACOTADOS_SINTETICOS);
    for (const rel of EMPACOTADOS_SINTETICOS) {
      assert.deepEqual(fs.readFileSync(path.join(saida, rel)), fs.readFileSync(path.join(raiz, rel)), rel);
      assert.equal(r.manifesto[rel], sha256(fs.readFileSync(path.join(raiz, rel))), rel);
    }
    assert.deepEqual(r.migrations, [
      { nome: '000_a.sql', sha256: sha256('CREATE TABLE a (id int);\n') },
      { nome: '001_b.sql', sha256: sha256('CREATE TABLE b (id int);\n') },
    ]);
    assert.equal(r.lockfileSha256, sha256(fs.readFileSync(path.join(raiz, 'package-lock.json'))));
  });

  test('arquivos .env na raiz são ignorados, nunca empacotados e não derrubam o pacote', () => {
    const { empacotarBackend } = carregar();
    const raiz = criarRaiz({ '.env': 'SMTP_SENHA=valor-real-muito-longo-123456789\n', '.env.local': 'X=1\n', '.env.production': 'Y=2\n', '.DS_Store': 'x', 'src/.DS_Store': 'x' });
    const saida = path.join(novoDiretorio(), 'pacote');
    assert.deepEqual(empacotarBackend({ saida, raiz }).arquivos, EMPACOTADOS_SINTETICOS);
  });

  test('fail-closed: item desconhecido na raiz do backend', () => {
    const { empacotarBackend } = carregar();
    const saida = path.join(novoDiretorio(), 'pacote');
    for (const extra of [{ 'segredos.json': '{}' }, { 'deploy.sh': 'x' }, { 'tmp/a.js': 'x' }, { 'dump.sql': 'x' }, { 'storage/img.png': 'x' }]) {
      recusa(() => empacotarBackend({ saida, raiz: criarRaiz(extra) }), 'ENTRADA_RAIZ_DESCONHECIDA');
    }
    assert.equal(fs.existsSync(saida), false);
  });

  test('fail-closed: extensão ou local fora da regra dentro das raízes', () => {
    const { empacotarBackend } = carregar();
    const saida = path.join(novoDiretorio(), 'pacote');
    for (const extra of [{ 'src/a.txt': 'x' }, { 'src/a.js.map': 'x' }, { 'src/a.json': '{}' }, { 'src/dados.sqlite': 'x' }, { 'src/imagem.png': 'x' }, { 'scripts/a.sh': 'x' }, { 'scripts/a.json': '{}' }, { 'migrations/a.js': 'x' }, { 'migrations/outro.json': '{}' }, { 'src/semextensao': 'x' }]) {
      recusa(() => empacotarBackend({ saida, raiz: criarRaiz(extra) }), 'ARQUIVO_NAO_PERMITIDO');
    }
    assert.equal(fs.existsSync(saida), false);
  });

  test('fail-closed: duplicatas do Finder (" 2.js") em qualquer raiz', () => {
    const { empacotarBackend } = carregar();
    const saida = path.join(novoDiretorio(), 'pacote');
    for (const rel of ['src/app 2.js', 'scripts/guarda-inicializacao 3.js', 'migrations/001_b 2.sql', 'src/email/assets/marca 2.png']) {
      recusa(() => empacotarBackend({ saida, raiz: criarRaiz({ [rel]: 'x' }) }), 'DUPLICATA_FINDER');
    }
    recusa(() => empacotarBackend({ saida, raiz: criarRaiz({ 'package 2.json': '{}' }) }), 'DUPLICATA_FINDER');
  });

  test('fail-closed: arquivos de segredo por nome dentro das raízes, antes da regra de extensão', () => {
    const { empacotarBackend } = carregar();
    const saida = path.join(novoDiretorio(), 'pacote');
    for (const rel of ['src/.env', 'src/.env.production', 'src/config/chave.pem', 'scripts/servidor.key', 'src/cert.p12', 'src/cert.pfx', 'src/id_rsa', 'src/id_ed25519', 'migrations/.env', 'src/senhas.kdbx', 'src/credentials.json']) {
      recusa(() => empacotarBackend({ saida, raiz: criarRaiz({ [rel]: 'x' }) }), 'SEGREDO_ARQUIVO');
    }
  });

  test('fail-closed: link simbólico dentro das raízes, mesmo para arquivo permitido', () => {
    const { empacotarBackend } = carregar();
    const raiz = criarRaiz();
    fs.symlinkSync(path.join(raiz, 'src', 'app.js'), path.join(raiz, 'src', 'atalho.js'));
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'pacote'), raiz }), 'ENTRADA_INVALIDA');
    const raiz2 = criarRaiz();
    fs.symlinkSync(novoDiretorio(), path.join(raiz2, 'src', 'pasta'));
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'pacote'), raiz: raiz2 }), 'ENTRADA_INVALIDA');
  });

  test('fail-closed: segredo no conteúdo, e a mensagem de erro nunca repete o valor', () => {
    const { empacotarBackend } = carregar();
    const casos = {
      CHAVE_PRIVADA: ["const k = `-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----`;\n", '-----BEGIN OPENSSH'],
      CHAVE_PRIVADA_RSA: ["const k = '-----BEGIN RSA PRIVATE KEY-----';\n", '-----BEGIN RSA'],
      AWS_ACCESS_KEY: ["const id = 'AKIAABCDEFGHIJKLMNOP';\n", 'AKIAABCDEFGHIJKLMNOP'],
      AWS_SECRET: ["aws_secret_access_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'\n", 'wJalrXUtnFEMI'],
      TOKEN_GITHUB: ["const t = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';\n", 'ghp_0123456789'],
      TOKEN_GITHUB_FINO: [`const t = 'github_pat_${'A1b2C3d4E5'.repeat(6)}';\n`, 'github_pat_A1b2'],
      TOKEN_SLACK: ["const t = 'xoxb-1234567890-abcdefghijkl';\n", 'xoxb-1234567890'],
      JWT: ["const j = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';\n", 'eyJhbGciOiJIUzI1NiJ9'],
      URL_COM_CREDENCIAL: ["const u = 'postgres://app:SuperSenha123@db.interno:5432/x';\n", 'SuperSenha123'],
      ATRIBUICAO_LITERAL: ["const SMTP_SENHA = 'Zx9kLm2PqRt7VbN4cD8fGh1J';\n", 'Zx9kLm2PqRt7VbN4cD8fGh1J'],
      ATRIBUICAO_LITERAL_OBJETO: ["module.exports = { apiKey: 'Zx9kLm2PqRt7VbN4cD8fGh1J' };\n", 'Zx9kLm2PqRt7VbN4cD8fGh1J'],
    };
    for (const [regra, [conteudo, trecho]] of Object.entries(casos)) {
      const saida = path.join(novoDiretorio(), 'pacote');
      const erro = recusaCom(() => empacotarBackend({ saida, raiz: criarRaiz({ 'src/config/x.js': conteudo }) }), 'SEGREDO_NO_CONTEUDO');
      assert.ok(erro.message.includes('src/config/x.js'), regra);
      assert.ok(!erro.message.includes(trecho), `${regra}: a mensagem repete o valor`);
      assert.equal(fs.existsSync(saida), false, regra);
    }
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'migrations/002_c.sql': "INSERT INTO t VALUES ('AKIAABCDEFGHIJKLMNOP');\n" }) }), 'SEGREDO_NO_CONTEUDO');
  });

  test('sem falso positivo: leitura de variável de ambiente, nomes de campo e valores curtos passam', () => {
    const { empacotarBackend } = carregar();
    const limpo = [
      "const senha = process.env.SMTP_SENHA;\n",
      "const { senha } = req.body;\n",
      "const TOKEN_HEADER = 'x-token';\n",
      "const SENHA_MINIMA = 'curta';\n",
      "const mensagem = 'A senha informada é inválida, tente de novo mais tarde';\n",
      "const API_KEY_NOME = 'MFA_TOTP_KEY_V1';\n",
      "const url = 'https://registry.npmjs.org/zod';\n",
      "const t = 'postgres://localhost:5432/banco';\n",
    ].join('');
    const saida = path.join(novoDiretorio(), 'pacote');
    assert.doesNotThrow(() => empacotarBackend({ saida, raiz: criarRaiz({ 'src/config/ok.js': limpo }) }));
  });

  test('a chave de teste pública do Turnstile passa, mas só ela: qualquer variação do literal continua recusada', () => {
    const { empacotarBackend } = carregar();
    const publica = "const SECRET_KEY_TESTE_SUCESSO = '1x0000000000000000000000000000000AA';\n";
    assert.doesNotThrow(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'src/config/t.js': publica }) }));
    for (const variacao of ['1x0000000000000000000000000000000AB', '1x0000000000000000000000000000000AAA', '4x0000000000000000000000000000000AA']) {
      const conteudo = `const SECRET_KEY_TESTE_SUCESSO = '${variacao}';\n`;
      recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'src/config/t.js': conteudo }) }), 'SEGREDO_NO_CONTEUDO');
    }
  });

  test('fail-closed: arquivo exigido ausente', () => {
    const { empacotarBackend } = carregar();
    for (const rel of ['package.json', 'package-lock.json', 'src/server.js', 'scripts/guarda-inicializacao.js']) {
      recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ [rel]: null }) }), 'ARQUIVO_AUSENTE');
    }
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'migrations/checksums.json': null, 'migrations/000_a.sql': 'x' }) }), 'ARQUIVO_AUSENTE');
  });

  test('fail-closed: migrations que não batem com o checksums.json (alterada, fora do manifesto, manifestada sem arquivo)', () => {
    const { empacotarBackend } = carregar();
    const raiz1 = criarRaiz();
    fs.appendFileSync(path.join(raiz1, 'migrations', '001_b.sql'), '-- alterada\n');
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: raiz1 }), 'MIGRATIONS_DIVERGENTES');
    const raiz2 = criarRaiz();
    fs.writeFileSync(path.join(raiz2, 'migrations', '002_nova.sql'), 'CREATE TABLE c ();\n');
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: raiz2 }), 'MIGRATIONS_DIVERGENTES');
    const raiz3 = criarRaiz();
    fs.rmSync(path.join(raiz3, 'migrations', '001_b.sql'));
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: raiz3 }), 'MIGRATIONS_DIVERGENTES');
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'migrations/checksums.json': '{ quebrado' }) }), 'MIGRATIONS_DIVERGENTES');
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'migrations/checksums.json': JSON.stringify({ algoritmo: 'md5', migrations: {} }) }) }), 'MIGRATIONS_DIVERGENTES');
  });

  test('fail-closed: lockfile fora do padrão (versão, origem, integridade, link)', () => {
    const { empacotarBackend } = carregar();
    const lock = (mod) => { const l = LOCK_VALIDO(); mod(l.packages['node_modules/zod'], l); return JSON.stringify(l); };
    for (const conteudo of [
      lock((p, l) => { l.lockfileVersion = 2; }),
      lock((p) => { p.resolved = 'git+ssh://git@github.com/x/y.git#abc'; }),
      lock((p) => { p.resolved = 'http://registry.npmjs.org/zod/-/zod-4.0.0.tgz'; }),
      lock((p) => { p.resolved = 'https://registry.exemplo.test/zod-4.0.0.tgz'; }),
      lock((p) => { delete p.integrity; }),
      lock((p) => { delete p.resolved; }),
      lock((p) => { delete p.resolved; delete p.integrity; p.link = true; }),
      '{ nao json',
    ]) {
      recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'package-lock.json': conteudo }) }), 'LOCKFILE_INSEGURO');
    }
  });

  test('fail-closed: package.json com hook de instalação ou sem engines do Node', () => {
    const { empacotarBackend } = carregar();
    for (const gancho of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
      const p = PACKAGE_VALIDO(); p.scripts[gancho] = 'node x.js';
      recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'package.json': JSON.stringify(p) }) }), 'HOOKS_DE_INSTALACAO');
    }
    const semEngines = PACKAGE_VALIDO(); delete semEngines.engines;
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'package.json': JSON.stringify(semEngines) }) }), 'PACKAGE_INVALIDO');
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'package.json': '{ quebrado' }) }), 'PACKAGE_INVALIDO');
  });

  test('fail-closed: arquivo acima do limite de tamanho', () => {
    const { empacotarBackend } = carregar();
    recusa(() => empacotarBackend({ saida: path.join(novoDiretorio(), 'p'), raiz: criarRaiz({ 'src/grande.js': 'a'.repeat(2048) }), limiteBytes: 1024 }), 'ARQUIVO_GRANDE');
  });

  test('saída segura: com conteúdo, dentro do backend, ausente ou inválida são recusadas sem escrever nada', () => {
    const { empacotarBackend } = carregar();
    const raiz = criarRaiz();
    const ocupada = novoDiretorio();
    fs.writeFileSync(path.join(ocupada, 'sobra.txt'), 'x');
    recusa(() => empacotarBackend({ saida: ocupada, raiz }), 'SAIDA_INVALIDA');
    assert.deepEqual(listar(ocupada), ['sobra.txt']);
    recusa(() => empacotarBackend({ saida: path.join(raiz, 'dist'), raiz }), 'SAIDA_INVALIDA');
    recusa(() => empacotarBackend({ saida: path.join(raiz, 'src', 'novo'), raiz }), 'SAIDA_INVALIDA');
    assert.equal(fs.existsSync(path.join(raiz, 'dist')), false);
    recusa(() => empacotarBackend({ raiz }), 'SAIDA_INVALIDA');
    recusa(() => empacotarBackend({ saida: '  ', raiz }), 'SAIDA_INVALIDA');
    const arquivo = path.join(novoDiretorio(), 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    recusa(() => empacotarBackend({ saida: arquivo, raiz }), 'SAIDA_INVALIDA');
  });

  test('sem pacote parcial: falha de cópia no meio apaga o que foi escrito e preserva diretório vazio preexistente', () => {
    const { empacotarBackend } = carregar();
    const raiz = criarRaiz();
    let chamadas = 0;
    const copiarArquivo = (origem, destino, flags) => {
      chamadas += 1;
      if (chamadas === 4) throw new Error('disco cheio simulado');
      fs.copyFileSync(origem, destino, flags);
    };
    const nova = path.join(novoDiretorio(), 'pacote');
    assert.throws(() => empacotarBackend({ saida: nova, raiz, copiarArquivo }), /disco cheio/);
    assert.equal(fs.existsSync(nova), false);
    chamadas = 0;
    const vazia = novoDiretorio();
    assert.throws(() => empacotarBackend({ saida: vazia, raiz, copiarArquivo }), /disco cheio/);
    assert.equal(fs.existsSync(vazia), true);
    assert.deepEqual(fs.readdirSync(vazia), []);
  });

  test('detecta alteração entre a leitura e a cópia (pacote diferente do manifesto)', () => {
    const { empacotarBackend } = carregar();
    const raiz = criarRaiz();
    const copiarArquivo = (origem, destino, flags) => {
      fs.copyFileSync(origem, destino, flags);
      if (destino.endsWith('app.js')) fs.appendFileSync(destino, '// adulterado\n');
    };
    const saida = path.join(novoDiretorio(), 'pacote');
    recusa(() => empacotarBackend({ saida, raiz, copiarArquivo }), 'PACOTE_DIVERGENTE');
    assert.equal(fs.existsSync(saida), false);
  });
});

describe('empacotar-backend — release do backend (manifesto, release.json e verificação)', () => {
  test('layout: backend/, manifesto no formato do sha256sum e release.json coerente', () => {
    const { gerarReleaseBackend } = carregar();
    const raiz = criarRaiz();
    const saida = path.join(novoDiretorio(), 'release');
    const { release } = gerarReleaseBackend({ saida, raiz, commit: COMMIT, rotulo: ROTULO, atual: true, agora: Date.parse('2026-11-04T10:15:00.000Z'), contratos: { 'exemplo-contrato': 2 } });
    assert.deepEqual(listar(saida).filter((f) => !f.startsWith('backend/')), ['manifesto-backend.sha256', 'release.json']);
    assert.deepEqual(listar(path.join(saida, 'backend')), EMPACOTADOS_SINTETICOS);
    const texto = fs.readFileSync(path.join(saida, 'manifesto-backend.sha256'), 'utf8');
    const linhas = texto.split('\n').filter(Boolean);
    assert.equal(linhas.length, EMPACOTADOS_SINTETICOS.length);
    for (const l of linhas) {
      assert.match(l, /^[0-9a-f]{64} {2}\S.*$/);
      assert.equal(sha256(fs.readFileSync(path.join(saida, 'backend', ...l.slice(66).split('/')))), l.slice(0, 64));
    }
    assert.deepEqual(Object.keys(release).sort(), ['atual', 'backend', 'commit', 'geradoEm', 'rotulo']);
    assert.equal(release.geradoEm, '2026-11-04T10:15:00.000Z');
    assert.deepEqual(Object.keys(release.backend).sort(), ['arquivos', 'contratos', 'lockfileSha256', 'manifestoSha256', 'migrations', 'node']);
    assert.equal(release.backend.arquivos, EMPACOTADOS_SINTETICOS.length);
    assert.equal(release.backend.manifestoSha256, sha256(texto));
    assert.equal(release.backend.node, '>=22');
    assert.deepEqual(release.backend.contratos, { 'exemplo-contrato': 2 });
    assert.equal(release.backend.migrations.length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(saida, 'release.json'), 'utf8')).commit, COMMIT);
  });

  test('o contratos-persistentes.json versionado é válido e, por ora, não declara nenhum contrato', () => {
    const { lerContratos } = carregar();
    assert.deepEqual(lerContratos(), {});
  });

  test('reprodutível: mesmo commit e mesmo instante geram manifesto e release.json idênticos', () => {
    const { gerarReleaseBackend } = carregar();
    const raiz = criarRaiz();
    const base = novoDiretorio();
    const agora = Date.parse('2026-11-04T10:15:00.000Z');
    gerarReleaseBackend({ saida: path.join(base, 'a'), raiz, commit: COMMIT, rotulo: ROTULO, atual: true, agora, contratos: {} });
    gerarReleaseBackend({ saida: path.join(base, 'b'), raiz, commit: COMMIT, rotulo: ROTULO, atual: true, agora, contratos: {} });
    for (const f of ['manifesto-backend.sha256', 'release.json']) assert.equal(fs.readFileSync(path.join(base, 'a', f), 'utf8'), fs.readFileSync(path.join(base, 'b', f), 'utf8'), f);
  });

  test('verificarReleaseBackend confere a release inteira e detecta alteração, remoção, intruso e manifesto adulterado', () => {
    const { gerarReleaseBackend, verificarReleaseBackend } = carregar();
    const saida = path.join(novoDiretorio(), 'release');
    gerarReleaseBackend({ saida, raiz: criarRaiz(), commit: COMMIT, rotulo: ROTULO, atual: true, contratos: {} });
    assert.doesNotThrow(() => verificarReleaseBackend(saida));

    const alvo = path.join(saida, 'backend', 'src', 'app.js');
    const original = fs.readFileSync(alvo);
    fs.appendFileSync(alvo, '//\n');
    recusa(() => verificarReleaseBackend(saida), 'RELEASE_DIVERGENTE');
    fs.writeFileSync(alvo, original);
    assert.doesNotThrow(() => verificarReleaseBackend(saida));

    fs.writeFileSync(path.join(saida, 'backend', 'src', 'intruso.js'), 'x');
    recusa(() => verificarReleaseBackend(saida), 'RELEASE_DIVERGENTE');
    fs.rmSync(path.join(saida, 'backend', 'src', 'intruso.js'));

    fs.rmSync(path.join(saida, 'backend', 'src', 'server.js'));
    assert.throws(() => verificarReleaseBackend(saida));
    fs.writeFileSync(path.join(saida, 'backend', 'src', 'server.js'), "'use strict';\nrequire('./app');\n");
    assert.doesNotThrow(() => verificarReleaseBackend(saida));

    const manifesto = path.join(saida, 'manifesto-backend.sha256');
    const texto = fs.readFileSync(manifesto, 'utf8');
    fs.writeFileSync(manifesto, texto.replace(/^./, (c) => (c === '0' ? '1' : '0')));
    recusa(() => verificarReleaseBackend(saida), 'RELEASE_DIVERGENTE');
  });

  test('fail-closed: commit, rótulo, coerência atual/retroativo, contratos e saída inválidos não escrevem nada', () => {
    const { gerarReleaseBackend } = carregar();
    const raiz = criarRaiz();
    const base = novoDiretorio();
    const s = (n) => path.join(base, n);
    recusa(() => gerarReleaseBackend({ saida: s('a'), raiz, commit: 'abc', rotulo: ROTULO, atual: true, contratos: {} }), 'COMMIT_INVALIDO');
    recusa(() => gerarReleaseBackend({ saida: s('b'), raiz, commit: COMMIT, rotulo: 'hml-x', atual: true, contratos: {} }), 'ROTULO_INVALIDO');
    recusa(() => gerarReleaseBackend({ saida: s('c'), raiz, commit: COMMIT, rotulo: '../../etc', atual: true, contratos: {} }), 'ROTULO_INVALIDO');
    recusa(() => gerarReleaseBackend({ saida: s('d'), raiz, commit: COMMIT, rotulo: ROTULO, atual: 'true', contratos: {} }), 'FATO_INVALIDO');
    recusa(() => gerarReleaseBackend({ saida: s('e'), raiz, commit: COMMIT, rotulo: `${ROTULO}-retroativo`, atual: true, contratos: {} }), 'FATO_INVALIDO');
    recusa(() => gerarReleaseBackend({ saida: s('f'), raiz, commit: COMMIT, rotulo: ROTULO, atual: false, contratos: {} }), 'FATO_INVALIDO');
    recusa(() => gerarReleaseBackend({ saida: s('g'), raiz, commit: COMMIT, rotulo: ROTULO, atual: true, contratos: { 'Nome Inválido': 1 } }), 'CONTRATOS_INVALIDOS');
    recusa(() => gerarReleaseBackend({ saida: s('h'), raiz, commit: COMMIT, rotulo: ROTULO, atual: true, contratos: { ok: 0 } }), 'CONTRATOS_INVALIDOS');
    recusa(() => gerarReleaseBackend({ saida: s('i'), raiz, commit: COMMIT, rotulo: ROTULO, atual: true, contratos: { ok: 1.5 } }), 'CONTRATOS_INVALIDOS');
    recusa(() => gerarReleaseBackend({ saida: path.join(REPO, 'release-backend'), commit: COMMIT, rotulo: ROTULO, atual: true, contratos: {} }), 'SAIDA_INVALIDA');
    for (const n of 'abcdefghi') assert.equal(fs.existsSync(s(n)), false, n);
    assert.equal(fs.existsSync(path.join(REPO, 'release-backend')), false);
  });

  test('linha de comando: gera a release do backend real, reconfere e sai 0; recusa com 1', () => {
    carregar();
    const saida = path.join(novoDiretorio(), 'release');
    const ok = spawnSync(process.execPath, [MODULO, '--saida', saida, '--commit', COMMIT, '--rotulo', `${ROTULO}-retroativo`, '--atual', 'false'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /RETROATIVA/);
    assert.match(ok.stdout, /backend \d+ arquivos/);
    assert.deepEqual(listar(saida).filter((f) => !f.startsWith('backend/')), ['manifesto-backend.sha256', 'release.json']);

    const repetida = spawnSync(process.execPath, [MODULO, '--saida', saida, '--commit', COMMIT, '--rotulo', ROTULO, '--atual', 'true'], { encoding: 'utf8' });
    assert.equal(repetida.status, 1);
    assert.match(repetida.stderr, /SAIDA_INVALIDA/);
    assert.equal(spawnSync(process.execPath, [MODULO], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [MODULO, '--saida', saida, '--commit', COMMIT, '--rotulo', ROTULO, '--atual', 'talvez'], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [MODULO, '--saida', path.join(novoDiretorio(), 'x'), '--commit', COMMIT, '--rotulo', ROTULO, '--atual', 'true', '--extra', '1'], { encoding: 'utf8' }).status, 1);
  });
});
