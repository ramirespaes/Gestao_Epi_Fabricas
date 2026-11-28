'use strict';

process.env.NODE_ENV = 'test';

// SonarCloud S2612: o pacote do backend sai legível só pelo dono, e a remoção ancorada devolve ao dono apenas o que
// precisa para esvaziar o diretório, sem acrescentar bits de grupo ou outros, inclusive quando falha no meio.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const { empacotarBackend } = require(path.join(REPO, 'deploy', 'hml', 'empacotar-backend.js'));
const { criarAncora } = require(path.join(REPO, 'deploy', 'hml', 'instalador', 'ancora.js'));

const temporarios = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-s2612-')); temporarios.push(d); return d; };
const liberar = (p) => {
  let info; try { info = fs.lstatSync(p); } catch { return; }
  if (!info.isDirectory()) return;
  fs.chmodSync(p, 0o700);
  for (const e of fs.readdirSync(p)) liberar(path.join(p, e));
};
afterEach(() => { while (temporarios.length) { const d = temporarios.pop(); liberar(d); fs.rmSync(d, { recursive: true, force: true }); } });

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const modo = (p) => fs.statSync(p).mode & 0o777;

// fs real com espionagem de fchmod e falha programada de unlink: só em teste (NODE_ENV=test).
function fsEspiao({ falharUnlink } = {}) {
  const chmods = [];
  const espiao = Object.create(fs);
  espiao.fchmodSync = (fd, m) => { chmods.push(m & 0o7777); return fs.fchmodSync(fd, m); };
  espiao.unlinkSync = (p) => {
    if (falharUnlink && path.basename(p) === falharUnlink) { const e = new Error(`EIO simulado: ${p}`); e.code = 'EIO'; throw e; }
    return fs.unlinkSync(p);
  };
  return { espiao, chmods };
}
const ancora = (fsImpl) => criarAncora({ modo: 'caminho', semGarantiaDeCorrida: true, fsImpl });

// árvore: <raiz>/alvo/{a.txt, sub/{b.txt, fundo/c.txt}} com os modos pedidos (arquivos 0400 ou 0444).
function criarArvore(raiz, modoDir, modoArquivo) {
  const alvo = path.join(raiz, 'alvo');
  fs.mkdirSync(path.join(alvo, 'sub', 'fundo'), { recursive: true });
  fs.writeFileSync(path.join(alvo, 'a.txt'), 'a');
  fs.writeFileSync(path.join(alvo, 'sub', 'b.txt'), 'b');
  fs.writeFileSync(path.join(alvo, 'sub', 'fundo', 'c.txt'), 'c');
  for (const f of ['a.txt', 'sub/b.txt', 'sub/fundo/c.txt']) fs.chmodSync(path.join(alvo, f), modoArquivo);
  for (const d of ['sub/fundo', 'sub', '.']) fs.chmodSync(path.join(alvo, d), modoDir);
  return alvo;
}
const diretoriosRestantes = (alvo) => ['.', 'sub', 'sub/fundo'].map((d) => path.join(alvo, d)).filter((d) => fs.existsSync(d));

describe('S2612 — pacote do backend', () => {
  test('cada arquivo do pacote sai 0600 e o conteúdo é idêntico à origem e ao manifesto', () => {
    const raiz = path.join(REPO, 'backend');
    const r = empacotarBackend({ raiz, saida: path.join(tmp(), 'pacote') });
    assert.ok(r.arquivos.length > 100);
    for (const rel of r.arquivos) {
      const destino = path.join(r.saida, ...rel.split('/'));
      assert.equal(modo(destino), 0o600, `${rel}: modo ${modo(destino).toString(8)}`);
      const conteudo = fs.readFileSync(destino);
      assert.equal(sha256(conteudo), r.manifesto[rel], `${rel}: manifesto`);
      assert.equal(sha256(conteudo), sha256(fs.readFileSync(path.join(fs.realpathSync(raiz), ...rel.split('/')))), `${rel}: origem`);
    }
  });
});

describe('S2612 — remoção ancorada só acrescenta bits do dono', () => {
  for (const [rotulo, modoDir] of [['0700 (preparo/trava)', 0o700], ['0750', 0o750], ['0555 (release selada)', 0o555], ['0500', 0o500]]) {
    test(`diretórios ${rotulo}: cada fchmod preserva grupo e outros e acrescenta só u+rwx; a árvore some`, () => {
      const raiz = tmp();
      criarArvore(raiz, modoDir, 0o444);
      const { espiao, chmods } = fsEspiao();
      const A = ancora(espiao);
      const base = A.abrirBase(raiz);
      assert.equal(A.removerArvore(base, 'alvo'), true);
      A.fecharTudo();
      assert.equal(fs.existsSync(path.join(raiz, 'alvo')), false);
      assert.equal(chmods.length, 3);
      for (const m of chmods) assert.equal(m, modoDir | 0o700, `fchmod ${m.toString(8)} para diretório ${modoDir.toString(8)}`);
    });
  }

  test('falha parcial em árvore 0700: nada restante ganha bits de grupo ou outros', () => {
    const raiz = tmp();
    const alvo = criarArvore(raiz, 0o700, 0o400);
    const { espiao } = fsEspiao({ falharUnlink: 'c.txt' });
    const A = ancora(espiao);
    const base = A.abrirBase(raiz);
    assert.throws(() => A.removerArvore(base, 'alvo'), (e) => e.code === 'EIO');
    A.fecharTudo();
    const restantes = diretoriosRestantes(alvo);
    assert.ok(restantes.length > 0);
    for (const d of restantes) assert.equal(modo(d) & 0o077, 0, `${path.relative(raiz, d)} ficou ${modo(d).toString(8)}`);
    assert.equal(fs.readFileSync(path.join(alvo, 'sub', 'fundo', 'c.txt'), 'utf8'), 'c');
  });

  test('falha parcial em release 0555: o resto fica 0755, como antes, e a nova tentativa remove tudo', () => {
    const raiz = tmp();
    const alvo = criarArvore(raiz, 0o555, 0o444);
    const { espiao } = fsEspiao({ falharUnlink: 'c.txt' });
    const A = ancora(espiao);
    const base = A.abrirBase(raiz);
    assert.throws(() => A.removerArvore(base, 'alvo'), (e) => e.code === 'EIO');
    A.fecharTudo();
    for (const d of diretoriosRestantes(alvo)) assert.equal(modo(d), 0o755, `${path.relative(raiz, d)} ficou ${modo(d).toString(8)}`);
    const B = ancora(fsEspiao().espiao);
    assert.equal(B.removerArvore(B.abrirBase(raiz), 'alvo'), true);
    B.fecharTudo();
    assert.equal(fs.existsSync(alvo), false);
  });
});
