'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { gerarRelease, verificarRelease, linhasDoManifesto } = require('../gerar-release');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = path.join(__dirname, '..', 'gerar-release.js');
const COMMIT = 'c'.repeat(40);
const ROTULO = 'hml-20261103T211530-ccccccc';
const temporarios = [];

function novoDiretorio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-release-'));
  temporarios.push(dir);
  return dir;
}
const sha256 = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
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
}

afterEach(() => {
  while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true });
});

describe('gerar-release — dois pacotes separados com manifestos verificáveis', () => {
  test('gera portal/ e painel/ separados, com as contagens das allowlists e release.json coerente', () => {
    const saida = path.join(novoDiretorio(), 'release');
    const { release } = gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: true, agora: Date.parse('2026-11-03T21:15:30.000Z') });

    const portal = require('../../../../frontend/publicacao/empacotar').lerAllowlist();
    const painel = require('../../../../frontend/publicacao/empacotar-painel').lerAllowlist();
    assert.deepEqual(listar(path.join(saida, 'portal')), [...portal].sort());
    assert.deepEqual(listar(path.join(saida, 'painel')), [...painel].sort());
    assert.equal(release.portal.arquivos, portal.length);
    assert.equal(release.painel.arquivos, 25);
    assert.deepEqual(Object.keys(release).sort(), ['atual', 'commit', 'geradoEm', 'painel', 'portal', 'rotulo']);
    assert.equal(release.commit, COMMIT);
    assert.equal(release.geradoEm, '2026-11-03T21:15:30.000Z');
    assert.deepEqual(listar(saida).filter((f) => !f.startsWith('portal/') && !f.startsWith('painel/')), ['manifesto-painel.sha256', 'manifesto-portal.sha256', 'release.json']);
  });

  test('isolamento entre os pacotes: nada do Painel no Portal e nada do Portal, Totem ou páginas no Painel', () => {
    const saida = path.join(novoDiretorio(), 'release');
    gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: true });
    assert.equal(listar(path.join(saida, 'portal')).some((f) => f.startsWith('painel-privado/')), false);
    const noPainel = listar(path.join(saida, 'painel'));
    for (const prefixo of ['portal/', 'pages/', 'totem/', 'institucional/', 'css/']) assert.equal(noPainel.some((f) => f.startsWith(prefixo)), false, prefixo);
  });

  test('manifestos no formato do sha256sum: hash, dois espaços, caminho relativo ao pacote, ordenados, e batem com os arquivos', () => {
    const saida = path.join(novoDiretorio(), 'release');
    gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: true });
    for (const nome of ['portal', 'painel']) {
      const texto = fs.readFileSync(path.join(saida, `manifesto-${nome}.sha256`), 'utf8');
      const linhas = texto.split('\n').filter(Boolean);
      assert.equal(texto.endsWith('\n'), true);
      assert.deepEqual(linhas, [...linhas].sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)));
      assert.equal(linhas.length, listar(path.join(saida, nome)).length);
      for (const linha of linhas) {
        assert.match(linha, /^[0-9a-f]{64} {2}[^\s].*$/);
        assert.equal(sha256(path.join(saida, nome, ...linha.slice(66).split('/'))), linha.slice(0, 64), linha);
      }
    }
    assert.equal(linhasDoManifesto({ 'b.js': '2'.repeat(64), 'a.js': '1'.repeat(64) }), `${'1'.repeat(64)}  a.js\n${'2'.repeat(64)}  b.js\n`);
  });

  test('verificarRelease confere a release inteira e detecta alteração, remoção, manifesto adulterado e arquivo intruso', () => {
    const saida = path.join(novoDiretorio(), 'release');
    gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: true });
    assert.doesNotThrow(() => verificarRelease(saida));

    const alvo = path.join(saida, 'painel', 'painel-privado', 'login.js');
    const original = fs.readFileSync(alvo);
    fs.appendFileSync(alvo, '\n;');
    recusa(() => verificarRelease(saida), 'RELEASE_DIVERGENTE');
    fs.writeFileSync(alvo, original);
    assert.doesNotThrow(() => verificarRelease(saida));

    fs.rmSync(path.join(saida, 'portal', 'favicon.svg'));
    assert.throws(() => verificarRelease(saida));
    fs.copyFileSync(path.join(REPO, 'frontend', 'favicon.svg'), path.join(saida, 'portal', 'favicon.svg'));
    assert.doesNotThrow(() => verificarRelease(saida));

    const manifesto = path.join(saida, 'manifesto-painel.sha256');
    const textoOriginal = fs.readFileSync(manifesto, 'utf8');
    fs.writeFileSync(manifesto, textoOriginal.replace(/^./, (c) => (c === '0' ? '1' : '0')));
    recusa(() => verificarRelease(saida), 'RELEASE_DIVERGENTE');
  });

  test('a release é reprodutível: mesmo commit e mesmo instante geram manifestos e release.json idênticos', () => {
    const base = novoDiretorio();
    const agora = Date.parse('2026-11-03T21:15:30.000Z');
    gerarRelease({ saida: path.join(base, 'a'), commit: COMMIT, rotulo: ROTULO, atual: true, agora });
    gerarRelease({ saida: path.join(base, 'b'), commit: COMMIT, rotulo: ROTULO, atual: true, agora });
    for (const arquivo of ['manifesto-portal.sha256', 'manifesto-painel.sha256', 'release.json']) {
      assert.equal(fs.readFileSync(path.join(base, 'a', arquivo), 'utf8'), fs.readFileSync(path.join(base, 'b', arquivo), 'utf8'), arquivo);
    }
  });

  test('release retroativa exige rótulo retroativo e marca atual=false; combinação incoerente é recusada', () => {
    const base = novoDiretorio();
    const { release } = gerarRelease({ saida: path.join(base, 'r'), commit: COMMIT, rotulo: `${ROTULO}-retroativo`, atual: false });
    assert.equal(release.atual, false);
    recusa(() => gerarRelease({ saida: path.join(base, 'x'), commit: COMMIT, rotulo: `${ROTULO}-retroativo`, atual: true }), 'FATO_INVALIDO');
    recusa(() => gerarRelease({ saida: path.join(base, 'y'), commit: COMMIT, rotulo: ROTULO, atual: false }), 'FATO_INVALIDO');
    assert.equal(fs.existsSync(path.join(base, 'x')) || fs.existsSync(path.join(base, 'y')), false);
  });

  test('fail-closed: commit, rótulo, flag ou saída inválidos não escrevem nada', () => {
    const base = novoDiretorio();
    const saida = path.join(base, 'release');
    recusa(() => gerarRelease({ saida, commit: 'abc', rotulo: ROTULO, atual: true }), 'COMMIT_INVALIDO');
    recusa(() => gerarRelease({ saida, commit: COMMIT, rotulo: 'hml-qualquer', atual: true }), 'ROTULO_INVALIDO');
    recusa(() => gerarRelease({ saida, commit: COMMIT, rotulo: '../../etc', atual: true }), 'ROTULO_INVALIDO');
    recusa(() => gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: 'true' }), 'FATO_INVALIDO');
    recusa(() => gerarRelease({ saida: '', commit: COMMIT, rotulo: ROTULO, atual: true }), 'SAIDA_INVALIDA');
    recusa(() => gerarRelease({ saida: path.join(REPO, 'release-hml'), commit: COMMIT, rotulo: ROTULO, atual: true }), 'SAIDA_INVALIDA');
    assert.equal(fs.existsSync(saida), false);
    assert.equal(fs.existsSync(path.join(REPO, 'release-hml')), false);

    const ocupada = path.join(base, 'ocupada');
    fs.mkdirSync(ocupada);
    fs.writeFileSync(path.join(ocupada, 'sobra.txt'), 'x');
    recusa(() => gerarRelease({ saida: ocupada, commit: COMMIT, rotulo: ROTULO, atual: true }), 'SAIDA_INVALIDA');
    assert.deepEqual(listar(ocupada), ['sobra.txt']);
  });

  test('falha de empacotador no meio da release não deixa pacote parcial e preserva diretório vazio preexistente', () => {
    const base = novoDiretorio();
    const frontendQuebrado = path.join(base, 'frontend');
    fs.cpSync(path.join(REPO, 'frontend', 'publicacao'), path.join(frontendQuebrado, 'publicacao'), { recursive: true });
    fs.writeFileSync(path.join(frontendQuebrado, 'publicacao', 'allowlist-painel.json'), JSON.stringify({ arquivos: ['painel-privado/nao-existe.html'] }));
    const saida = path.join(base, 'release');
    assert.throws(() => gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: true, frontend: frontendQuebrado }));
    assert.equal(fs.existsSync(saida), false, 'saída criada pelo módulo é removida');

    fs.mkdirSync(saida);
    assert.throws(() => gerarRelease({ saida, commit: COMMIT, rotulo: ROTULO, atual: true, frontend: frontendQuebrado }));
    assert.equal(fs.existsSync(saida), true, 'diretório vazio preexistente é preservado');
    assert.deepEqual(fs.readdirSync(saida), []);
  });

  test('linha de comando: gera, reconfere e sai 0; recusa com 1 e mensagem de código', () => {
    const saida = path.join(novoDiretorio(), 'release');
    const ok = spawnSync(process.execPath, [SCRIPT, '--saida', saida, '--commit', COMMIT, '--rotulo', `${ROTULO}-retroativo`, '--atual', 'false'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /RETROATIVA/);
    assert.match(ok.stdout, /painel 25 arquivos/);

    const repetida = spawnSync(process.execPath, [SCRIPT, '--saida', saida, '--commit', COMMIT, '--rotulo', ROTULO, '--atual', 'true'], { encoding: 'utf8' });
    assert.equal(repetida.status, 1);
    assert.match(repetida.stderr, /SAIDA_INVALIDA/);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--saida', saida, '--commit', COMMIT, '--rotulo', ROTULO, '--atual', 'talvez'], { encoding: 'utf8' }).status, 1);
  });
});
