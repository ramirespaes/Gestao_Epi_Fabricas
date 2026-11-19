'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const A = require('../lib/arquivos.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dirTemp = (p = 'backup-arq-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function origemSintetica() {
  const raiz = dirTemp('backup-arq-origem-');
  fs.mkdirSync(path.join(raiz, 'a', 'b'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'vazio'));
  fs.writeFileSync(path.join(raiz, 'um.bin'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(raiz, 'a', 'dois.txt'), 'conteudo sintetico dois');
  fs.writeFileSync(path.join(raiz, 'a', 'b', 'tres.bin'), crypto.randomBytes(300000));
  return raiz;
}

function estadoDaArvore(raiz) {
  const out = [];
  const ir = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isDirectory()) { out.push(`D ${path.relative(raiz, p)} ${st.mtimeNs}`); ir(p); }
      else out.push(`F ${path.relative(raiz, p)} ${st.size} ${st.mtimeNs} ${st.ino} ${sha(fs.readFileSync(p))}`);
    }
  };
  ir(raiz);
  return out;
}

const novoRun = () => dirTemp('backup-arq-run-');

test('listarArvore: só arquivos regulares, ordem estável, diretório vazio ignorado', () => {
  const raiz = origemSintetica();
  const { entradas, anomalias } = A.listarArvore(raiz);
  assert.deepEqual(entradas.map((e) => e.rel), ['a/b/tres.bin', 'a/dois.txt', 'um.bin']);
  assert.deepEqual(anomalias, []);
  assert.equal(entradas[2].tamanho, 4);
});

test('listarArvore: link simbólico vira anomalia e não é seguido', () => {
  const raiz = origemSintetica();
  fs.symlinkSync('/etc/hosts', path.join(raiz, 'link'));
  const { entradas, anomalias } = A.listarArvore(raiz);
  assert.ok(!entradas.some((e) => e.rel === 'link'));
  assert.deepEqual(anomalias, [{ rel: 'link', tipo: 'LINK_SIMBOLICO' }]);
});

test('fingerprint: igual sem mudança; muda com conteúdo, mtime, novo arquivo e remoção', () => {
  const raiz = origemSintetica();
  const f = () => A.fingerprint(A.listarArvore(raiz));
  const base = f();
  assert.equal(base.arquivos, 3);
  assert.equal(base.bytes, 4 + 'conteudo sintetico dois'.length + 300000);
  assert.deepEqual(f(), base);
  fs.appendFileSync(path.join(raiz, 'um.bin'), 'x');
  const apos = f();
  assert.notEqual(apos.sha256, base.sha256);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(raiz, 'a', 'dois.txt'), t, t);
  const aposMtime = f();
  assert.notEqual(aposMtime.sha256, apos.sha256);
  fs.writeFileSync(path.join(raiz, 'novo.txt'), 'n');
  const aposNovo = f();
  assert.notEqual(aposNovo.sha256, aposMtime.sha256);
  fs.unlinkSync(path.join(raiz, 'novo.txt'));
  assert.notEqual(f().sha256, aposNovo.sha256);
});

test('cópia sem alteração: 1 tentativa, SEM_ALTERACAO, hashes e conteúdo idênticos, origem intacta', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const antes = estadoDaArvore(raiz);
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run });
  assert.equal(r.concorrencia, 'SEM_ALTERACAO');
  assert.equal(r.tentativas.length, 1);
  assert.equal(r.escolhida, 1);
  const f = r.fontes[0];
  assert.equal(f.arquivos.length, 3);
  for (const a of f.arquivos) {
    const copia = path.join(run, 'tentativas', '1', 'imagens', ...a.caminho.split('/'));
    assert.equal(sha(fs.readFileSync(copia)), a.sha256);
    assert.equal(a.sha256, sha(fs.readFileSync(path.join(raiz, ...a.caminho.split('/')))));
    assert.equal(fs.statSync(copia).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(path.join(run, 'tentativas', '1')).mode & 0o777, 0o700);
  assert.deepEqual(estadoDaArvore(raiz), antes);
});

test('origem somente leitura (0555/0444): a cópia funciona e nada é escrito na origem', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const antes = estadoDaArvore(raiz);
  const ir = (d, modoD, modoF) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.lstatSync(p).isDirectory()) { ir(p, modoD, modoF); fs.chmodSync(p, modoD); } else fs.chmodSync(p, modoF);
    }
  };
  ir(raiz, 0o555, 0o444);
  fs.chmodSync(raiz, 0o555);
  try {
    const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run });
    assert.equal(r.concorrencia, 'SEM_ALTERACAO');
  } finally {
    fs.chmodSync(raiz, 0o755);
    ir(raiz, 0o755, 0o644);
  }
  assert.deepEqual(estadoDaArvore(raiz), antes);
});

test('alteração concorrente só na 1ª tentativa: 2ª tentativa estável e a 1ª é preservada', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const aposArquivo = ({ tentativa, indice }) => {
    if (tentativa === 1 && indice === 0) fs.appendFileSync(path.join(raiz, 'um.bin'), 'alterado');
  };
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, ganchos: { aposArquivo } });
  assert.equal(r.concorrencia, 'SEM_ALTERACAO');
  assert.equal(r.tentativas.length, 2);
  assert.equal(r.tentativas[0].estavel, false);
  assert.equal(r.tentativas[1].estavel, true);
  assert.equal(r.escolhida, 2);
  assert.ok(fs.existsSync(path.join(run, 'tentativas', '1', 'imagens', 'um.bin')));
  assert.ok(fs.existsSync(path.join(run, 'tentativas', '2', 'imagens', 'um.bin')));
});

test('alteração em todas as tentativas: 3 tentativas, COM_ALTERACAO_CONCORRENTE, evidências preservadas', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const aposArquivo = ({ indice }) => { if (indice === 0) fs.appendFileSync(path.join(raiz, 'a', 'dois.txt'), '+'); };
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, ganchos: { aposArquivo } });
  assert.equal(r.concorrencia, 'COM_ALTERACAO_CONCORRENTE');
  assert.equal(r.tentativas.length, 3);
  assert.ok(r.tentativas.every((t) => t.estavel === false));
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(path.join(run, 'tentativas', String(n), 'imagens', 'um.bin')));
});

test('arquivo novo durante a cópia é detectado (F0 ≠ F1)', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const aposArquivo = ({ tentativa, indice }) => { if (tentativa === 1 && indice === 1) fs.writeFileSync(path.join(raiz, 'chegou.txt'), 'novo'); };
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, ganchos: { aposArquivo } });
  assert.equal(r.tentativas[0].estavel, false);
  assert.notEqual(r.tentativas[0].fontes[0].f0.sha256, r.tentativas[0].fontes[0].f1.sha256);
  assert.equal(r.tentativas[1].estavel, true);
  assert.equal(r.fontes[0].arquivos.length, 4);
});

test('arquivo removido antes de ser copiado: tentativa instável e nova tentativa estável', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const aposArquivo = ({ tentativa, indice }) => { if (tentativa === 1 && indice === 0) fs.unlinkSync(path.join(raiz, 'um.bin')); };
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, ganchos: { aposArquivo } });
  assert.equal(r.tentativas[0].estavel, false);
  assert.equal(r.concorrencia, 'SEM_ALTERACAO');
  assert.equal(r.fontes[0].arquivos.length, 2);
});

test('arquivo trocado por outro com mesmo tamanho (inode novo) é detectado', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  const aposArquivo = ({ tentativa, indice }) => {
    if (tentativa === 1 && indice === 2) {
      const p = path.join(raiz, 'um.bin');
      fs.writeFileSync(`${p}.novo`, Buffer.from([9, 9, 9, 9]));
      fs.renameSync(`${p}.novo`, p);
    }
  };
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, ganchos: { aposArquivo } });
  assert.equal(r.tentativas[0].estavel, false);
});

test('link simbólico na origem: erro fatal E_ANOMALIA_ORIGEM, nada publicado', async () => {
  const raiz = origemSintetica();
  fs.symlinkSync('/etc/hosts', path.join(raiz, 'link'));
  const run = novoRun();
  await assert.rejects(A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run }), (e) => e.codigo === 'E_ANOMALIA_ORIGEM' && e.saida === 5);
});

// Roda a cópia num processo filho com timeout: abrir um FIFO sem escritor bloquearia para sempre o processo que testa.
const FILHO_TROCA_ESPECIAL = `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [arquivosJs, raiz, run, tipo] = process.argv.slice(1);
const A = require(arquivosJs);
const nfd = () => fs.readdirSync('/dev/fd').length;
const aposArquivo = ({ indice }) => {
  if (indice !== 0) return;
  const alvo = path.join(raiz, 'b.bin');
  fs.unlinkSync(alvo);
  if (tipo === 'fifo') { if (spawnSync('mkfifo', [alvo]).status !== 0) process.exit(90); } else fs.mkdirSync(alvo);
};
const antes = nfd();
A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, ganchos: { aposArquivo } })
  .then(() => console.log(JSON.stringify({ ok: true })))
  .catch((e) => console.log(JSON.stringify({ codigo: e.codigo ?? null, saida: e.saida ?? null, msg: e.codigo ? null : String(e.message).slice(0, 80), fdsAntes: antes, fdsDepois: nfd() })))
  .finally(() => process.exit(0));
`;
const TEM_MKFIFO = spawnSync('sh', ['-c', 'command -v mkfifo']).status === 0 && fs.existsSync('/dev/fd');

test('arquivo trocado por FIFO ou diretório entre a listagem e a abertura: E_ANOMALIA_ORIGEM, sem bloqueio, sem descritor vazado e sem cópia parcial', { skip: !TEM_MKFIFO && 'mkfifo ou /dev/fd indisponível' }, () => {
  for (const tipo of ['fifo', 'diretorio']) {
    const raiz = dirTemp('backup-arq-origem-');
    for (const nome of ['a.bin', 'b.bin', 'c.bin']) fs.writeFileSync(path.join(raiz, nome), `sintetico-${nome}`);
    const run = novoRun();
    const r = spawnSync(process.execPath, ['-e', FILHO_TROCA_ESPECIAL, path.join(__dirname, '..', 'lib', 'arquivos.js'), raiz, run, tipo], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    assert.equal(r.error, undefined, `${tipo}: a cópia bloqueou ou falhou (${r.error && r.error.code})`);
    assert.equal(r.status, 0, `${tipo}: ${r.stderr}`);
    const saida = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(saida.codigo, 'E_ANOMALIA_ORIGEM', `${tipo}: ${JSON.stringify(saida)}`);
    assert.equal(saida.saida, 5);
    assert.ok(saida.fdsDepois <= saida.fdsAntes, `${tipo}: descritores ${saida.fdsAntes} -> ${saida.fdsDepois}`);
    const tdir = path.join(run, 'tentativas', '1', 'imagens');
    assert.ok(fs.existsSync(path.join(tdir, 'a.bin')), `${tipo}: o 1º arquivo já copiado fica na tentativa (nada é publicado)`);
    assert.ok(!fs.existsSync(path.join(tdir, 'b.bin')), `${tipo}: nenhum arquivo de destino para o item trocado`);
    assert.ok(!fs.existsSync(path.join(tdir, 'c.bin')), `${tipo}: nada copiado depois da falha`);
    assert.ok(!fs.existsSync(path.join(run, 'MANIFEST-ARQUIVOS.json')), `${tipo}: nenhum manifesto publicado`);
  }
});

test('número de tentativas fora de 1..3 é recusado', async () => {
  const raiz = origemSintetica();
  for (const n of [0, 4, 1.5, '2']) {
    await assert.rejects(A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: novoRun(), maxTentativas: n }), (e) => e.codigo === 'E_CONFIG');
  }
});

test('espaço insuficiente e limite de bytes: falham antes de copiar', async () => {
  const raiz = origemSintetica();
  const run = novoRun();
  await assert.rejects(A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, espacoLivre: () => 10 }), (e) => e.codigo === 'E_ESPACO_INSUFICIENTE');
  await assert.rejects(A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: novoRun(), limiteBytes: 1000 }), (e) => e.codigo === 'E_LIMITE_EXCEDIDO');
  assert.ok(!fs.existsSync(path.join(run, 'tentativas', '1', 'imagens', 'um.bin')));
});

test('limite de bytes inválido (NaN, Infinity, 0, negativo, fracionário, texto, null): E_CONFIG antes de criar qualquer coisa', async () => {
  const raiz = origemSintetica();
  for (const limite of [Number.NaN, Infinity, 0, -1, 1.5, '1000', null]) {
    const run = novoRun();
    await assert.rejects(
      A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: run, limiteBytes: limite }),
      (e) => e.codigo === 'E_CONFIG' && e.saida === 2,
      `limite=${String(limite)}`,
    );
    assert.deepEqual(fs.readdirSync(run), [], `nada criado com limite=${String(limite)}`);
  }
});

test('limite de bytes válido (padrão e explícito) continua copiando', async () => {
  const raiz = origemSintetica();
  const r1 = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: novoRun() });
  assert.equal(r1.escolhida, 1);
  const r2 = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz }], runDir: novoRun(), limiteBytes: 10 * 1024 ** 2 });
  assert.equal(r2.escolhida, 1);
});

test('duas fontes: cada uma com seus fingerprints; alteração em uma torna a tentativa instável', async () => {
  const a = origemSintetica();
  const b = origemSintetica();
  const run = novoRun();
  const aposArquivo = ({ tentativa, fonte, indice }) => { if (tentativa === 1 && fonte === 'fiscalizacao' && indice === 0) fs.appendFileSync(path.join(b, 'um.bin'), 'z'); };
  const r = await A.copiaControlada({ fontes: [{ id: 'imagens', raiz: a }, { id: 'fiscalizacao', raiz: b }], runDir: run, ganchos: { aposArquivo } });
  assert.equal(r.tentativas[0].estavel, false);
  assert.equal(r.tentativas[0].fontes[0].estavel, true);
  assert.equal(r.tentativas[0].fontes[1].estavel, false);
  assert.equal(r.concorrencia, 'SEM_ALTERACAO');
});

test('parseReferencias: aceita NDJSON válido e recusa linhas inválidas', () => {
  const h = 'a'.repeat(64);
  const ok = A.parseReferencias(`{"sha256":"${h}","tamanho_bytes":10,"chave":"x/y.webp"}\n\n{"sha256":"${h}"}\n`);
  assert.equal(ok.length, 2);
  for (const ruim of ['nao json', '{"sha256":"curto"}', `{"sha256":"${h}","chave":"../fora"}`, `{"sha256":"${h}","chave":"/abs"}`, `{"sha256":"${h}","tamanho_bytes":-1}`, `{"sha256":"${h}","extra":1}`]) {
    assert.throws(() => A.parseReferencias(ruim), (e) => e.codigo === 'E_REFERENCIAS_INVALIDAS', ruim);
  }
});

test('verificarReferencias: completo, faltante, divergente, órfãos e lista vazia', () => {
  const f1 = { caminho: 'p/um.webp', tamanho_bytes: 4, sha256: 'a'.repeat(64) };
  const f2 = { caminho: 'p/dois.webp', tamanho_bytes: 5, sha256: 'b'.repeat(64) };
  const f3 = { caminho: 'p/orfao.webp', tamanho_bytes: 6, sha256: 'c'.repeat(64) };
  const arquivos = [f1, f2, f3];
  let r = A.verificarReferencias(arquivos, [{ sha256: f1.sha256 }, { sha256: f2.sha256, tamanho_bytes: 5, chave: 'p/dois.webp' }]);
  assert.equal(r.status, 'VERIFICADO_COMPLETO');
  assert.equal(r.orfaos_total, 1);
  r = A.verificarReferencias(arquivos, [{ sha256: 'd'.repeat(64) }]);
  assert.equal(r.status, 'COM_PROBLEMAS');
  assert.equal(r.faltantes_total, 1);
  r = A.verificarReferencias(arquivos, [{ sha256: f1.sha256, chave: 'p/dois.webp' }]);
  assert.equal(r.divergentes_total, 1);
  r = A.verificarReferencias(arquivos, [{ sha256: f1.sha256, tamanho_bytes: 99 }]);
  assert.equal(r.divergentes_total, 1);
  r = A.verificarReferencias(arquivos, []);
  assert.equal(r.status, 'VERIFICADO_COMPLETO');
  assert.equal(r.total, 0);
  assert.equal(r.orfaos_total, 3);
});
