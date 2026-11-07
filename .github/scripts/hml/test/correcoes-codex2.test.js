'use strict';

process.env.NODE_ENV = 'test';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Correções da segunda auditoria independente do Codex (B01 a B05 e R01 a R06). Cada
 * teste reproduz uma sonda do Codex (ou um cenário equivalente, incluindo falhas
 * encadeadas e trocas adversariais de caminhos) e foi escrito ANTES da correção (RED).
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MODULO = path.join(REPO, 'deploy', 'hml', 'instalador', 'instalar-release.js');
const COORD = path.join(REPO, 'deploy', 'hml', 'instalador', 'coordenacao.js');
const COMPAT = path.join(REPO, 'deploy', 'hml', 'instalador', 'compatibilidade.js');
const AGORA0 = Date.parse('2026-11-04T12:00:00.000Z');
const NPM = '/usr/bin/npm';
const temporarios = [];

const R = (n) => `hml-20261104T1${n}0000-${String(n).repeat(7)}`;
const COMMIT = (n) => String(n).repeat(40);
const sha256 = (c) => crypto.createHash('sha256').update(c).digest('hex');
const inst = () => require(MODULO);
const criarAncoraPorCaminho = (op) => require(path.join(REPO, 'deploy', 'hml', 'instalador', 'ancora.js')).criarAncora({ ...op, modo: 'caminho', semGarantiaDeCorrida: true });
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-corr-'));
  temporarios.push(dir);
  return dir;
};
const lerJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const aprovado = (dir) => sha256(fs.readFileSync(path.join(dir, 'release.json')));
const existeLink = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const falha = (promessa) => promessa.then(() => assert.fail('esperava recusa'), (e) => e);

function criarRelease({ componente = 'portal', n = 1, arquivos, secao = {}, commit } = {}) {
  const dir = tmp();
  const conteudos = arquivos || { 'index.html': `<p>v${n}</p>`, 'js/app.js': `// v${n}\n` };
  const manifesto = {};
  for (const [rel, c] of Object.entries(conteudos)) {
    fs.mkdirSync(path.dirname(path.join(dir, componente, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, componente, rel), c);
    manifesto[rel] = sha256(c);
  }
  const texto = `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, `manifesto-${componente}.sha256`), texto);
  const release = { commit: commit || COMMIT(n), rotulo: R(n), atual: true, geradoEm: '2026-11-04T10:00:00.000Z', [componente]: { arquivos: Object.keys(manifesto).length, manifestoSha256: sha256(texto), ...secao } };
  fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return dir;
}
// Backend coerente: cada migration declarada existe no pacote, com o checksums.json e o engines do package.json.
function criarBackend({ n = 1, migrations = ['000_a.sql'], contratos = {}, declaradas, engines = '>=22', sqlExtra = {}, checksumsAdulterado } = {}) {
  const lock = '{"lockfileVersion":3}';
  const sqls = Object.fromEntries(migrations.map((nome) => [`migrations/${nome}`, `-- ${nome}\n`]));
  Object.assign(sqls, Object.fromEntries(Object.entries(sqlExtra).map(([nome, c]) => [`migrations/${nome}`, c])));
  const hashes = Object.fromEntries(Object.entries(sqls).map(([rel, c]) => [path.posix.basename(rel), sha256(c)]));
  const checksums = checksumsAdulterado || { algoritmo: 'sha256', migrations: hashes };
  const arquivos = { 'package.json': JSON.stringify({ engines: { node: engines } }), 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, ...sqls, 'migrations/checksums.json': JSON.stringify(checksums) };
  const lista = (declaradas || migrations).map((nome) => ({ nome, sha256: sha256(`-- ${nome}\n`) }));
  return criarRelease({ componente: 'backend', n, arquivos, secao: { lockfileSha256: sha256(lock), node: '>=22', migrations: lista, contratos } });
}
function criarAmbiente() {
  const raiz = tmp();
  const dirs = { www: path.join(raiz, 'www'), app: path.join(raiz, 'app'), data: path.join(raiz, 'data'), secrets: path.join(raiz, 'secrets') };
  for (const d of [dirs.www, dirs.app, path.join(dirs.data, 'imagens'), dirs.secrets]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.secrets, 'backend.env'), 'SEGREDO=nao-mexer\n');
  fs.writeFileSync(path.join(dirs.data, 'imagens', 'a.png'), 'png');
  const config = {
    raizesPersistentes: [dirs.data, dirs.secrets], retencao: 3,
    componentes: {
      portal: { tipo: 'estatico', base: dirs.www, nome: 'app' },
      backend: {
        tipo: 'backend', base: dirs.app, nome: 'backend',
        linksPersistentes: [{ nome: '.env', destino: path.join(dirs.secrets, 'backend.env') }],
        dependencias: { comando: [NPM, 'ci', '--omit=dev', '--ignore-scripts'] },
      },
    },
  };
  const releases = (c) => path.join(config.componentes[c].base, '.releases', config.componentes[c].nome);
  const link = (c) => path.join(config.componentes[c].base, config.componentes[c].nome);
  return { raiz, ...dirs, config, releases, link };
}
function criarDeps(amb, extra = {}) {
  let tick = 0; let pid = 100;
  const chamadas = { reiniciar: 0, saude: 0, processo: 0 };
  const deps = {
    criarAncora: criarAncoraPorCaminho,
    agora: () => AGORA0 + (tick++) * 100,
    esperar: async () => {},
    usuario: () => 'operador-teste',
    executar: async (cmd, args, opc) => { fs.mkdirSync(path.join(opc.cwd, 'node_modules', 'zod'), { recursive: true }); fs.writeFileSync(path.join(opc.cwd, 'node_modules', 'zod', 'i.js'), '1'); },
    reiniciar: async () => { chamadas.reiniciar += 1; },
    verificarSaude: async () => { chamadas.saude += 1; return { ok: true }; },
    identificarProcesso: async () => { chamadas.processo += 1; pid += 1; return { pid, cwd: fs.realpathSync(amb.link('backend')) }; },
    consultarCoordenacao: async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date(AGORA0).toISOString() }),
    ...extra,
  };
  if (deps.consultarCoordenacao) require(path.join(REPO, 'deploy', 'hml', 'instalador', 'coordenacao.js')).homologarProvedorParaTeste(deps.consultarCoordenacao);
  return { deps, chamadas };
}
const observadoDe = (...migrations) => ({ banco: 'hml', origem: 'sonda-teste', coletadoEm: new Date(AGORA0).toISOString(), migrations, contratos: {} });
const opc = (dir, extra = {}) => ({ releaseSha256Esperado: aprovado(dir), observado: observadoDe('000_a.sql'), ...extra });
async function instalarBackend(amb, n, deps, extra = {}, criar = {}) {
  const dir = criarBackend({ n, ...criar });
  return inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir, extra), deps });
}
async function instalarPortal(amb, n, deps, extra = {}) {
  const dir = criarRelease({ n });
  return inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir), ...extra }, deps });
}

afterEach(() => {
  while (temporarios.length) {
    const d = temporarios.pop();
    const liberar = (p) => { try { fs.chmodSync(p, 0o755); } catch { return; } let e; try { e = fs.readdirSync(p, { withFileTypes: true }); } catch { return; } for (const x of e) if (x.isDirectory()) liberar(path.join(p, x.name)); };
    liberar(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ auxiliares desta rodada

const NUCLEO = path.join(REPO, 'deploy', 'hml', 'instalador', 'nucleo.js');
const PACOTE = path.join(REPO, 'deploy', 'hml', 'empacotar-backend.js');
const NGINX = path.join(REPO, 'deploy', 'hml', 'nginx', 'renderizar-modelo.js');
const FINAIS = ['CONCLUIDA', 'REVERTIDA_AUTOMATICA', 'FALHOU', 'ABORTADA', 'RECUPERADA'];
const rotuloDoLink = (amb, c) => path.basename(fs.readlinkSync(amb.link(c)));
const diarioDe = (amb, c) => fs.readFileSync(path.join(amb.releases(c), 'diario.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const estadoDe = (amb, c) => lerJson(path.join(amb.releases(c), 'estado.json'));
const identificar = (amb, c) => inst().identificar({ config: amb.config, componente: c });
function arvore(dir) {
  const itens = [];
  const andar = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      let marca = r;
      if (e.isSymbolicLink()) marca += ` -> ${fs.readlinkSync(path.join(abs, e.name))}`;
      else if (e.isFile()) marca += ` #${sha256(fs.readFileSync(path.join(abs, e.name)))} ${(fs.statSync(path.join(abs, e.name)).mode & 0o777).toString(8)}`;
      itens.push(marca);
      if (e.isDirectory()) andar(path.join(abs, e.name), r);
    }
  };
  andar(dir, '');
  return itens.sort();
}
// Troca um diretório por um link para o destino (o original é só renomeado, como faria um escritor concorrente).
function redirecionar(alvo, destino) {
  if (existeLink(alvo)) fs.renameSync(alvo, `${alvo}.orig`);
  fs.symlinkSync(destino, alvo);
}
// Dispara `acao` uma única vez, imediatamente antes da primeira chamada de `primitiva` cujo primeiro argumento case com `casa`.
function armadilha(primitiva, casa, acao) {
  const original = fs[primitiva];
  let disparada = false;
  fs[primitiva] = function interceptada(...args) {
    if (!disparada && typeof args[0] === 'string' && casa(args[0])) { disparada = true; fs[primitiva] = original; acao(args[0]); }
    return original.apply(this, args);
  };
  return () => { fs[primitiva] = original; };
}
async function comArmadilha(primitiva, casa, acao, trabalho) {
  const desarmar = armadilha(primitiva, casa, acao);
  try { return await trabalho(); } finally { desarmar(); }
}
// Simulador de processo: o diretório e o PID só mudam quando o serviço é reiniciado.
function simulador(amb, extra = {}) {
  const sim = { rodando: null, pid: 100, reinicios: 0 };
  const { deps, chamadas } = criarDeps(amb, {
    reiniciar: async () => { sim.reinicios += 1; sim.rodando = fs.realpathSync(amb.link('backend')); sim.pid += 1; },
    identificarProcesso: async () => ({ pid: sim.pid, cwd: sim.rodando || amb.raiz }),
    ...extra,
  });
  return { sim, deps, chamadas };
}
async function instalarDir(amb, componente, dir, deps, extra = {}) {
  const opcoes = componente === 'backend' ? opc(dir, extra) : { releaseSha256Esperado: aprovado(dir), ...extra };
  return inst().instalar({ config: amb.config, componente, release: dir, opcoes, deps });
}
const reverterBackend = (amb, deps, extra = {}) => inst().reverter({ config: amb.config, componente: 'backend', opcoes: { observado: observadoDe('000_a.sql'), ...extra }, deps });
// Invariante central: release declarada comprovada só se link, metadados e processo coincidem.
async function exigirNaoDivergir(amb, sim, rotulo = 'backend') {
  const est = estadoDe(amb, rotulo);
  if (est.atual && est.atual.comprovada === true) {
    assert.equal(rotuloDoLink(amb, rotulo), est.atual.rotulo, 'link difere do estado comprovado');
    assert.equal(path.basename(sim.rodando), est.atual.rotulo, 'processo difere do estado comprovado');
    assert.equal(lerJson(path.join(amb.releases(rotulo), 'versao.json')).rotulo, est.atual.rotulo, 'versao.json difere do estado comprovado');
  }
  const id = await identificar(amb, rotulo);
  if (id.integro) {
    assert.equal(path.basename(sim.rodando), id.rotulo, 'identificar disse íntegro com processo diferente do link');
  }
}

// ===================================================================================== B01

describe('B01 — escritas e exclusões ancoradas: nenhum ancestral trocado pode redirecionar para persistentes', () => {
  test('meta/ trocado por link durante a espera das dependências: recusado e nada vai para o persistente (sonda do Codex)', async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    const { deps } = criarDeps(amb, { executar: async () => { redirecionar(path.join(amb.releases('backend'), 'meta'), amb.data); } });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(arvore(amb.data), antes, 'nada foi escrito no persistente');
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('.releases/<nome> trocado por link durante a espera é recusado', async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    const { deps } = criarDeps(amb, { executar: async () => { redirecionar(amb.releases('backend'), amb.data); } });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(arvore(amb.data), antes);
  });

  test('.releases trocado por link durante a espera é recusado', async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    const { deps } = criarDeps(amb, { executar: async () => { redirecionar(path.join(amb.app, '.releases'), amb.data); } });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(arvore(amb.data), antes);
  });

  test('o diretório de preparo trocado por link para o persistente não tem permissões nem arquivos tocados', async () => {
    const amb = criarAmbiente();
    const fora = path.join(amb.data, 'homonimos');
    const dir = criarBackend({ n: 1 });
    // O persistente tem arquivos de mesmo nome e conteúdo idêntico aos da release: a reconferência de hash não salva o ataque.
    for (const rel of ['package.json', 'package-lock.json', 'src/server.js', 'migrations/checksums.json', 'migrations/000_a.sql']) {
      fs.mkdirSync(path.dirname(path.join(fora, rel)), { recursive: true });
      fs.writeFileSync(path.join(fora, rel), fs.readFileSync(path.join(dir, 'backend', rel)), { mode: 0o600 });
    }
    const antes = arvore(amb.data);
    const { deps } = criarDeps(amb, { executar: async (cmd, args, o) => { redirecionar(o.cwd, fora); } });
    const e = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps }));
    assert.ok(e.codigo, 'recusado');
    assert.deepEqual(arvore(amb.data), antes, 'conteúdo e modos do persistente intactos');
    assert.equal(existeLink(amb.link('backend')), false);
  });

  // As três janelas abaixo (entre a conferência e o uso, dentro de uma mesma operação síncrona) só são fechadas pelo kernel,
  // com a âncora real por descritor (/proc/self/fd, Linux). A âncora por caminho (usada nos demais testes, em qualquer
  // plataforma) detecta uma troca ocorrida ENTRE operações, mas não esta. Por isso: Linux apenas, com a âncora padrão.
  const SEM_PROC = process.platform === 'linux' ? false : 'exige a âncora real /proc/self/fd (Linux); executa no CI';
  const depsReais = (amb, extra = {}) => criarDeps(amb, { criarAncora: undefined, ...extra }).deps;

  test('troca de .releases/<nome> na janela entre a verificação e a abertura do diário não grava no persistente', { skip: SEM_PROC }, async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    const raiz = amb.releases('portal');
    await comArmadilha('openSync', (p) => p.endsWith('diario.jsonl'), () => redirecionar(raiz, amb.data), () => falha(instalarPortal(amb, 1, depsReais(amb))));
    assert.deepEqual(arvore(amb.data), antes, 'a gravação ficou no diretório verificado');
  });

  test('troca de meta/ na janela entre a verificação e a gravação do metadado não grava no persistente', { skip: SEM_PROC }, async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    const meta = path.join(amb.releases('portal'), 'meta');
    // A gravação ancorada conclui no diretório já verificado: o que não pode é ir para o persistente.
    await comArmadilha('openSync', (p) => /\.json\.tmp-\d+$/.test(p) && p.includes(R(1)), () => redirecionar(meta, amb.data), () => instalarPortal(amb, 1, depsReais(amb)).catch(() => null));
    assert.deepEqual(arvore(amb.data), antes);
    assert.ok(fs.readdirSync(`${meta}.orig`).some((n) => n.includes(R(1))), 'o metadado ficou no diretório que foi verificado');
  });

  test('troca do diretório de preparo na janela entre a cópia e o chmod não altera modos do persistente', { skip: SEM_PROC }, async () => {
    const amb = criarAmbiente();
    const fora = path.join(amb.data, 'homonimos');
    fs.mkdirSync(fora, { recursive: true });
    fs.writeFileSync(path.join(fora, 'index.html'), 'dado persistente', { mode: 0o600 });
    fs.writeFileSync(path.join(fora, 'a.js'), 'dado persistente', { mode: 0o600 });
    const antes = arvore(amb.data);
    const trocar = () => {
      const preparo = fs.readdirSync(amb.releases('portal')).find((n) => n.startsWith('.preparo-'));
      if (preparo) redirecionar(path.join(amb.releases('portal'), preparo), fora);
    };
    await comArmadilha('openSync', (p) => p.endsWith('/index.html') && p.startsWith('/proc/'), trocar, () => instalarPortal(amb, 1, depsReais(amb)).catch(() => null));
    assert.deepEqual(arvore(amb.data), antes, 'nenhum modo nem conteúdo do persistente mudou');
  });

  test('entrada do preparo trocada por link para o persistente antes do rename final nunca é publicada como release (T01)', async () => {
    const amb = criarAmbiente();
    const fora = path.join(amb.data, 'espelho');
    fs.mkdirSync(fora, { recursive: true });
    fs.writeFileSync(path.join(fora, 'index.html'), '<p>v1</p>\n'.replace('\n', ''));
    fs.mkdirSync(path.join(fora, 'js'));
    fs.writeFileSync(path.join(fora, 'js', 'app.js'), '// v1\n');
    const antes = arvore(amb.data);
    // Gatilho: imediatamente antes do rename do preparo para o nome da release, troca a entrada por um link.
    await comArmadilha('renameSync', (p) => p.includes('.preparo-'), () => {
      const preparo = fs.readdirSync(amb.releases('portal')).find((n) => n.startsWith('.preparo-'));
      const abs = path.join(amb.releases('portal'), preparo);
      fs.renameSync(abs, `${abs}.original`);
      fs.symlinkSync(fora, abs);
    }, async () => {
      const e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps));
      assert.ok(['RELEASE_SUBSTITUIDA', 'CAMINHO_OPERACIONAL_INVALIDO'].includes(e.codigo), e.codigo);
    });
    assert.equal(existeLink(amb.link('portal')), false, 'nenhum ponteiro foi criado');
    assert.deepEqual(arvore(amb.data), antes, 'nada foi escrito no persistente');
    const id = await identificar(amb, 'portal');
    assert.equal(id.integro, false);
  });

  test('release publicada como link para o persistente com hashes corretos é reprovada pela identificação (T01)', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const release = path.join(amb.releases('portal'), R(1));
    const persistente = path.join(amb.data, 'espelho');
    fs.mkdirSync(persistente, { recursive: true });
    fs.chmodSync(release, 0o755);
    fs.chmodSync(path.join(release, 'js'), 0o755);
    for (const rel of ['index.html', 'js/app.js']) {
      fs.mkdirSync(path.dirname(path.join(persistente, rel)), { recursive: true });
      fs.copyFileSync(path.join(release, rel), path.join(persistente, rel));
    }
    fs.rmSync(release, { recursive: true, force: true });
    fs.symlinkSync(persistente, release);
    const id = await identificar(amb, 'portal');
    assert.equal(id.integro, false, 'hashes corretos não bastam: a release precisa ser um diretório real');
    assert.equal(id.consistente, false);
    const e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.ok(e.codigo, 'nenhuma nova instalação sobre um link de release');
  });

  test('diretório operacional gravável por grupo ou outros é recusado (fail-closed)', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    fs.chmodSync(amb.releases('portal'), 0o775);
    let e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.equal(e.codigo, 'DIRETORIO_NAO_CONFIAVEL');
    fs.chmodSync(amb.releases('portal'), 0o755);
    fs.chmodSync(path.join(amb.releases('portal'), 'meta'), 0o777);
    e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.equal(e.codigo, 'DIRETORIO_NAO_CONFIAVEL');
    fs.chmodSync(path.join(amb.releases('portal'), 'meta'), 0o755);
    fs.chmodSync(amb.www, 0o775);
    e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.equal(e.codigo, 'DIRETORIO_NAO_CONFIAVEL');
    fs.chmodSync(amb.www, 0o755);
    assert.equal((await instalarPortal(amb, 2, criarDeps(amb).deps)).resultado, 'INSTALADA', 'com as permissões certas volta a funcionar');
  });

  test('dono diferente do usuário de execução é recusado', () => {
    const N = require(NUCLEO);
    const info = fs.statSync(tmp());
    assert.doesNotThrow(() => N.validarDiretorioConfiavel(info, info.uid));
    assert.throws(() => N.validarDiretorioConfiavel(info, info.uid + 1), (e) => e.codigo === 'DIRETORIO_NAO_CONFIAVEL');
  });

  test('um link no lugar de um diretório operacional não é aberto nem seguido, e a remoção apaga só o link', () => {
    const A = criarAncoraPorCaminho({});
    const real = tmp(); const raiz = tmp();
    fs.mkdirSync(path.join(real, 'x')); fs.writeFileSync(path.join(real, 'x', 'dado'), '1');
    fs.symlinkSync(path.join(real, 'x'), path.join(raiz, 'x'));
    const base = A.abrirBase(raiz);
    assert.throws(() => A.abrirFilho(base, 'x'), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO');
    A.removerArvore(base, 'x');
    assert.equal(existeLink(path.join(raiz, 'x')), false);
    assert.equal(fs.readFileSync(path.join(real, 'x', 'dado'), 'utf8'), '1', 'o alvo do link não foi tocado');
    A.fecharTudo();
  });

  test('remover uma árvore com link interno para o persistente remove só o link', () => {
    const A = criarAncoraPorCaminho({});
    const raiz = tmp(); const persistente = tmp();
    fs.writeFileSync(path.join(persistente, 'dado'), 'preservar');
    fs.mkdirSync(path.join(raiz, 'rel', 'sub'), { recursive: true });
    fs.symlinkSync(persistente, path.join(raiz, 'rel', 'sub', 'ponte'));
    const base = A.abrirBase(raiz);
    A.removerArvore(base, 'rel');
    assert.equal(existeLink(path.join(raiz, 'rel')), false);
    assert.equal(fs.readFileSync(path.join(persistente, 'dado'), 'utf8'), 'preservar');
    A.fecharTudo();
  });

  test('nenhuma operação usa process.chdir, e uma escrita relativa pendente continua indo para o diretório de origem', async () => {
    const amb = criarAmbiente();
    const original = process.chdir;
    let chamadas = 0;
    process.chdir = function proibido() { chamadas += 1; throw new Error('process.chdir é proibido nas operações do instalador'); };
    const pendente = path.join(tmp(), 'origem');
    fs.mkdirSync(pendente);
    const cwdAntes = process.cwd();
    try {
      // E/S assíncrona relativa já enfileirada (com a fila de threads reduzida pelo ambiente de teste) durante a instalação.
      const escrita = (async () => { process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '1'; await fs.promises.writeFile(path.join(pendente, 'pendente.txt'), 'ok'); })();
      await instalarPortal(amb, 1, criarDeps(amb).deps);
      await instalarPortal(amb, 2, criarDeps(amb).deps);
      await inst().reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps: criarDeps(amb).deps });
      await inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps });
      await falha(instalarPortal(amb, 1, criarDeps(amb).deps, { releaseSha256Esperado: '0'.repeat(64) }));
      await escrita;
    } finally { process.chdir = original; }
    assert.equal(chamadas, 0);
    assert.equal(process.cwd(), cwdAntes);
    assert.equal(fs.readFileSync(path.join(pendente, 'pendente.txt'), 'utf8'), 'ok');
  });

  test('o código do instalador não contém nenhum uso de process.chdir', () => {
    for (const arq of ['instalador/instalar-release.js', 'instalador/nucleo.js', 'instalador/ancora.js', 'instalador/compatibilidade.js', 'instalador/coordenacao.js']) {
      const codigo = fs.readFileSync(path.join(REPO, 'deploy', 'hml', arq), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert.doesNotMatch(codigo, /\bchdir\s*\(/, arq);
      assert.doesNotMatch(codigo, /process\.cwd\s*\(/, arq);
    }
  });
});

// ===================================================================================== B02

describe('B02 — nada é declarado comprovado quando processo, links e metadados divergem', () => {
  async function doisReleases(amb, extra = {}) {
    const s = simulador(amb, extra);
    const dir1 = criarBackend({ n: 1 });
    const dir2 = criarBackend({ n: 2 });
    await instalarDir(amb, 'backend', dir1, s.deps);
    await instalarDir(amb, 'backend', dir2, s.deps);
    return { ...s, dir1, dir2 };
  }
  const falhaEmEstado = (condicao) => {
    const original = fs.renameSync;
    const controle = { armada: false, disparos: 0 };
    fs.renameSync = function interceptada(origem, destino) {
      if (controle.armada && path.basename(String(destino)) === 'estado.json' && condicao(controle)) {
        controle.disparos += 1;
        throw Object.assign(new Error('EIO sintético'), { code: 'EIO' });
      }
      return original.apply(this, arguments);
    };
    controle.restaurar = () => { fs.renameSync = original; };
    return controle;
  };

  test('erro ao gravar o estado depois do reinício da reversão: o processo volta a coincidir com o link, ou fica crítico (sonda do Codex)', async () => {
    const amb = criarAmbiente();
    const { sim, deps } = await doisReleases(amb);
    const ctl = falhaEmEstado((c) => c.disparos === 0);
    let e;
    try {
      const original = deps.reiniciar;
      deps.reiniciar = async () => { await original(); ctl.armada = true; };
      e = await falha(reverterBackend(amb, deps));
    } finally { ctl.restaurar(); }
    assert.equal(ctl.disparos, 1, 'a falha foi injetada');
    assert.equal(e.codigo, 'FALHA_POS_REINICIO');
    await exigirNaoDivergir(amb, sim);
    assert.equal(e.detalhes.recuperado, true);
    assert.equal(rotuloDoLink(amb, 'backend'), R(2), 'voltou à release de antes da operação');
    assert.equal(path.basename(sim.rodando), R(2), 'o processo também');
    const est = estadoDe(amb, 'backend');
    assert.deepEqual([est.atual.rotulo, est.atual.comprovada, est.critico || null], [R(2), true, null]);
    assert.ok(FINAIS.includes(diarioDe(amb, 'backend').at(-1).passo));
  });

  test('falha persistente no estado: o diário fica aberto, a próxima operação reconcilia como crítica e bloqueia', async () => {
    const amb = criarAmbiente();
    const { sim, deps, dir2 } = await doisReleases(amb);
    const ctl = falhaEmEstado(() => true);
    const original = deps.reiniciar;
    deps.reiniciar = async () => { await original(); ctl.armada = true; };
    let e;
    try { e = await falha(reverterBackend(amb, deps)); } finally { ctl.restaurar(); }
    assert.ok(e.codigo);
    await exigirNaoDivergir(amb, sim);
    assert.ok(!FINAIS.includes(diarioDe(amb, 'backend').at(-1).passo), 'diário aberto');
    const sem = await identificar(amb, 'backend');
    assert.equal(sem.integro, false, 'operação interrompida nunca é íntegra');
    deps.reiniciar = original;
    const rec = await inst().reconciliar({ config: amb.config, componente: 'backend', deps });
    assert.equal(rec.interrompida, true);
    assert.equal(rec.comprovada, false);
    assert.ok(estadoDe(amb, 'backend').critico, 'estado crítico registrado');
    const outro = await falha(instalarBackend(amb, 3, deps));
    assert.equal(outro.codigo, 'ESTADO_CRITICO');
    const rev = await falha(reverterBackend(amb, deps));
    assert.equal(rev.codigo, 'ESTADO_CRITICO');
    const confirmar = await instalarDir(amb, 'backend', dir2, deps);
    assert.equal(confirmar.resultado, 'CONFIRMADA');
    assert.equal(estadoDe(amb, 'backend').critico || null, null);
    await exigirNaoDivergir(amb, sim);
  });

  test('rollback automático cuja gravação final falha depois do reinício da anterior não declara prova antiga', async () => {
    const amb = criarAmbiente();
    const s = simulador(amb);
    await instalarDir(amb, 'backend', criarBackend({ n: 1 }), s.deps);
    const ctl = falhaEmEstado(() => true);
    const original = s.deps.reiniciar;
    let chamadas = 0;
    s.deps.reiniciar = async () => {
      chamadas += 1;
      await original();
      if (chamadas === 1) throw new Error('falha do reinício da nova');
      ctl.armada = true;
    };
    let e;
    try { e = await falha(instalarDir(amb, 'backend', criarBackend({ n: 2 }), s.deps)); } finally { ctl.restaurar(); }
    assert.ok(e.codigo);
    await exigirNaoDivergir(amb, s.sim);
    assert.ok(!FINAIS.includes(diarioDe(amb, 'backend').at(-1).passo), 'diário aberto');
    s.deps.reiniciar = original;
    const rec = await inst().reconciliar({ config: amb.config, componente: 'backend', deps: s.deps });
    assert.equal(rec.comprovada, false);
    assert.ok(estadoDe(amb, 'backend').critico);
    assert.equal((await falha(instalarBackend(amb, 3, s.deps))).codigo, 'ESTADO_CRITICO');
  });

  test('operação interrompida depois de começar o reinício é reconciliada como não comprovada e crítica, com o link na nova ou na antiga', async () => {
    for (const linkNaAntiga of [false, true]) {
      const amb = criarAmbiente();
      const { sim, deps } = await doisReleases(amb);
      if (linkNaAntiga) { fs.rmSync(amb.link('backend')); fs.symlinkSync(path.posix.join('.releases', 'backend', R(1)), amb.link('backend')); }
      const raiz = amb.releases('backend');
      fs.appendFileSync(path.join(raiz, 'diario.jsonl'), `${JSON.stringify({ id: 'queda', passo: 'INICIO', operacao: 'instalar', de: R(1), para: R(2) })}\n${JSON.stringify({ id: 'queda', passo: 'REINICIANDO' })}\n`);
      const rec = await inst().reconciliar({ config: amb.config, componente: 'backend', deps });
      assert.equal(rec.situacao, linkNaAntiga ? 'ABORTADA' : 'NOVA_EM_USO_SEM_CONFIRMACAO');
      assert.equal(rec.comprovada, false);
      const est = estadoDe(amb, 'backend');
      assert.equal(est.atual.comprovada, false, `link na antiga=${linkNaAntiga}`);
      assert.ok(est.critico, `link na antiga=${linkNaAntiga}`);
      void sim;
    }
  });

  test('sem reinício registrado, abortar não torna o estado crítico (controle)', async () => {
    const amb = criarAmbiente();
    const { deps } = await doisReleases(amb);
    fs.rmSync(amb.link('backend')); fs.symlinkSync(path.posix.join('.releases', 'backend', R(1)), amb.link('backend'));
    fs.appendFileSync(path.join(amb.releases('backend'), 'diario.jsonl'), `${JSON.stringify({ id: 'queda', passo: 'INICIO', operacao: 'instalar', de: R(1), para: R(2) })}\n`);
    await inst().reconciliar({ config: amb.config, componente: 'backend', deps });
    assert.equal(estadoDe(amb, 'backend').critico || null, null);
  });

  test('o passo REINICIANDO é gravado no diário antes de cada reinício', async () => {
    const amb = criarAmbiente();
    let visto = null;
    const { deps } = criarDeps(amb, { reiniciar: async () => { visto = diarioDe(amb, 'backend').map((p) => p.passo); } });
    await instalarBackend(amb, 1, deps);
    assert.ok(visto.includes('REINICIANDO'), JSON.stringify(visto));
  });

  test('estado crítico bloqueia nova instalação e reversão; só a confirmação da release em uso ou a exceção explícita liberam', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const dir2 = criarBackend({ n: 2, migrations: ['000_a.sql', '001_b.sql'] });
    await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir2, opcoes: opc(dir2, { observado: observadoDe('000_a.sql', '001_b.sql') }), deps: criarDeps(amb, { reiniciar: async () => { throw new Error('falha'); } }).deps }));
    assert.ok(estadoDe(amb, 'backend').critico);
    const migs = ['000_a.sql', '001_b.sql'];
    const bloqueada = await falha(instalarBackend(amb, 3, criarDeps(amb).deps, { observado: observadoDe(...migs) }, { migrations: migs }));
    assert.equal(bloqueada.codigo, 'ESTADO_CRITICO');
    assert.equal((await falha(reverterBackend(amb, criarDeps(amb).deps, { observado: observadoDe(...migs) }))).codigo, 'ESTADO_CRITICO');
    const r = await instalarBackend(amb, 3, criarDeps(amb).deps, { observado: observadoDe(...migs), resolverEstadoCritico: true }, { migrations: migs });
    assert.equal(r.resultado, 'INSTALADA');
    const ev = estadoDe(amb, 'backend').historico.at(-1);
    assert.ok(ev.excecoes.some((x) => x.nome === 'resolverEstadoCritico'));
    assert.equal(estadoDe(amb, 'backend').critico || null, null);
  });
});

// ===================================================================================== B03

describe('B03 — identificação local fechada', () => {
  test('versao.json nulo, lista, texto, número, vazio ou com tipos errados nunca é íntegro (sonda do Codex)', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const arq = path.join(amb.releases('portal'), 'versao.json');
    const valido = lerJson(arq);
    for (const conteudo of ['null', '[]', '"x"', '123', 'true', '{}', JSON.stringify({ ...valido, commit: 7 }), JSON.stringify({ ...valido, extra: 1 }), JSON.stringify({ rotulo: valido.rotulo })]) {
      fs.writeFileSync(arq, conteudo);
      const id = await identificar(amb, 'portal');
      assert.equal(id.integro, false, conteudo);
      assert.equal(id.consistente, false, conteudo);
      assert.ok(id.problemas.length > 0, conteudo);
    }
    fs.writeFileSync(arq, JSON.stringify(valido));
    assert.equal((await identificar(amb, 'portal')).integro, true);
  });

  test('metadado da release nulo, lista ou sem manifesto não derruba a identificação nem passa como íntegro', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const arq = path.join(amb.releases('portal'), 'meta', `${R(1)}.json`);
    const original = fs.readFileSync(arq, 'utf8');
    for (const conteudo of ['null', '[]', '{}', '{"manifesto":null}', '{"manifesto":[]}', '"x"']) {
      fs.writeFileSync(arq, conteudo);
      const id = await identificar(amb, 'portal');
      assert.equal(id.integro, false, conteudo);
    }
    fs.writeFileSync(arq, original);
    assert.equal((await identificar(amb, 'portal')).integro, true);
  });

  test('estado.json nulo ou com forma errada é relatado e não é sobrescrito automaticamente', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const arq = path.join(amb.releases('portal'), 'estado.json');
    for (const conteudo of ['null', '[]', '{"historico":3}']) {
      fs.writeFileSync(arq, conteudo);
      assert.equal((await identificar(amb, 'portal')).integro, false, conteudo);
      const e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
      assert.equal(e.codigo, 'ESTADO_INVALIDO', conteudo);
      assert.equal(fs.readFileSync(arq, 'utf8'), conteudo);
    }
  });
});

// ===================================================================================== B04

describe('B04 — o conteúdo publicado é sincronizado em disco antes do ponteiro', () => {
  function instrumentar() {
    const eventos = [];
    const abertos = new Map();
    const o = { open: fs.openSync, close: fs.closeSync, fsync: fs.fsyncSync, rename: fs.renameSync };
    fs.openSync = function (p, ...r) { const fd = o.open.call(this, p, ...r); abertos.set(fd, path.resolve(String(p))); return fd; };
    fs.closeSync = function (fd) { abertos.delete(fd); return o.close.call(this, fd); };
    fs.fsyncSync = function (fd) { eventos.push({ tipo: 'fsync', caminho: abertos.get(fd) || '?' }); return o.fsync.call(this, fd); };
    fs.renameSync = function (a, b) { const r = o.rename.call(this, a, b); eventos.push({ tipo: 'rename', de: path.resolve(String(a)), para: path.resolve(String(b)) }); return r; };
    return { eventos, restaurar: () => { fs.openSync = o.open; fs.closeSync = o.close; fs.fsyncSync = o.fsync; fs.renameSync = o.rename; } };
  }

  test('todo arquivo e diretório do preparo é sincronizado antes do rename para a release e do link', async () => {
    const amb = criarAmbiente();
    const inst_ = instrumentar();
    try { await instalarPortal(amb, 1, criarDeps(amb).deps); } finally { inst_.restaurar(); }
    const ev = inst_.eventos;
    const iRelease = ev.findIndex((e) => e.tipo === 'rename' && e.para.endsWith(`/${R(1)}`));
    const iLink = ev.findIndex((e) => e.tipo === 'rename' && e.para === amb.link('portal'));
    assert.ok(iRelease > 0 && iLink > iRelease, 'ordem: release publicada antes do link');
    for (const alvo of ['index.html', 'js/app.js']) {
      const i = ev.findIndex((e) => e.tipo === 'fsync' && e.caminho.includes('.preparo-') && e.caminho.endsWith(`/${alvo}`));
      assert.ok(i >= 0 && i < iRelease, `${alvo} sincronizado antes do rename`);
    }
    for (const dir of ['/js']) {
      const i = ev.findIndex((e) => e.tipo === 'fsync' && e.caminho.includes('.preparo-') && e.caminho.endsWith(dir));
      assert.ok(i >= 0 && i < iRelease, `diretório ${dir} sincronizado antes do rename`);
    }
    const doPreparoRaiz = ev.slice(0, iRelease).filter((e) => e.tipo === 'fsync' && /\.preparo-[^/]+$/.test(e.caminho));
    assert.ok(doPreparoRaiz.length >= 2, `o diretório de preparo é sincronizado depois de preenchido e de novo depois de somente leitura (${doPreparoRaiz.length})`);
    const iRaiz = ev.findIndex((e, k) => k > iRelease && e.tipo === 'fsync' && e.caminho === amb.releases('portal'));
    assert.ok(iRaiz > iRelease && iRaiz < iLink, 'a raiz de releases é sincronizada depois do rename e antes do link');
  });

  test('as dependências instaladas também são sincronizadas antes da publicação', async () => {
    const amb = criarAmbiente();
    const inst_ = instrumentar();
    try { await instalarBackend(amb, 1, criarDeps(amb).deps); } finally { inst_.restaurar(); }
    const ev = inst_.eventos;
    const iRelease = ev.findIndex((e) => e.tipo === 'rename' && e.para.endsWith(`/${R(1)}`));
    const i = ev.findIndex((e) => e.tipo === 'fsync' && e.caminho.includes('node_modules') && e.caminho.endsWith('i.js'));
    assert.ok(i >= 0 && i < iRelease, 'node_modules/zod/i.js sincronizado antes do rename');
  });

  test('falha de fsync em arquivo ou diretório do preparo aborta sem publicar release nem link', async () => {
    for (const alvo of ['index.html', '/js']) {
      const amb = criarAmbiente();
      const mapa = new Map();
      const o = { open: fs.openSync, close: fs.closeSync, fsync: fs.fsyncSync };
      fs.openSync = function (p, ...r) { const fd = o.open.call(this, p, ...r); mapa.set(fd, path.resolve(String(p))); return fd; };
      fs.closeSync = function (fd) { mapa.delete(fd); return o.close.call(this, fd); };
      fs.fsyncSync = function (fd) { const p = mapa.get(fd) || ''; if (p.includes('.preparo-') && p.endsWith(alvo)) throw Object.assign(new Error('EIO sintético'), { code: 'EIO' }); return o.fsync.call(this, fd); };
      let e;
      try { e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps)); } finally { fs.openSync = o.open; fs.closeSync = o.close; fs.fsyncSync = o.fsync; }
      assert.ok(e.code === 'EIO' || e.codigo, alvo);
      assert.equal(existeLink(amb.link('portal')), false, alvo);
      assert.deepEqual(fs.readdirSync(amb.releases('portal')).filter((n) => n === R(1) || n.startsWith('.preparo-')), [], alvo);
    }
  });

  test('diretório sem suporte a fsync gera aviso explícito e, se exigido, recusa antes de publicar', async () => {
    const semSuporte = async (extra) => {
      const amb = criarAmbiente();
      const mapa = new Map();
      const o = { open: fs.openSync, close: fs.closeSync, fsync: fs.fsyncSync };
      fs.openSync = function (p, ...r) { const fd = o.open.call(this, p, ...r); mapa.set(fd, path.resolve(String(p))); return fd; };
      fs.closeSync = function (fd) { mapa.delete(fd); return o.close.call(this, fd); };
      fs.fsyncSync = function (fd) { const p = mapa.get(fd); if (p && fs.statSync(p).isDirectory()) throw Object.assign(new Error('EINVAL sintético'), { code: 'EINVAL' }); return o.fsync.call(this, fd); };
      try { return { amb, resultado: await falha(instalarPortal(amb, 1, criarDeps(amb).deps, extra)).catch(() => null) }; } finally { fs.openSync = o.open; fs.closeSync = o.close; fs.fsyncSync = o.fsync; }
    };
    const livre = await (async () => {
      const amb = criarAmbiente();
      const mapa = new Map();
      const o = { open: fs.openSync, close: fs.closeSync, fsync: fs.fsyncSync };
      fs.openSync = function (p, ...r) { const fd = o.open.call(this, p, ...r); mapa.set(fd, path.resolve(String(p))); return fd; };
      fs.closeSync = function (fd) { mapa.delete(fd); return o.close.call(this, fd); };
      fs.fsyncSync = function (fd) { const p = mapa.get(fd); if (p && fs.statSync(p).isDirectory()) throw Object.assign(new Error('EINVAL sintético'), { code: 'EINVAL' }); return o.fsync.call(this, fd); };
      try { return await instalarPortal(amb, 1, criarDeps(amb).deps); } finally { fs.openSync = o.open; fs.closeSync = o.close; fs.fsyncSync = o.fsync; }
    })();
    assert.equal(livre.resultado, 'INSTALADA');
    assert.ok(livre.avisos.some((a) => a.codigo === 'DURABILIDADE_NAO_GARANTIDA'), JSON.stringify(livre.avisos));
    const { amb, resultado } = await semSuporte({ exigirDurabilidade: true });
    assert.ok(resultado && resultado.codigo === 'DURABILIDADE_NAO_SUPORTADA', JSON.stringify(resultado && resultado.codigo));
    assert.equal(existeLink(amb.link('portal')), false);
  });
});

// ===================================================================================== scanner

describe('Scanner do empacotador: nomes sem distinção de caixa e literais curtos ou sem dígitos', () => {
  const { empacotarBackend } = require(PACOTE);
  const lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': {}, 'node_modules/zod': { version: '4.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz', integrity: 'sha512-AAAA' } } });
  function raizCom(extra = {}) {
    const raiz = tmp();
    const arquivos = {
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0', engines: { node: '>=22' } }), 'package-lock.json': lock,
      'src/server.js': "'use strict';\n", 'scripts/guarda-inicializacao.js': "'use strict';\n", 'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: {} }), ...extra,
    };
    for (const [rel, c] of Object.entries(arquivos)) { fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true }); fs.writeFileSync(path.join(raiz, rel), c); }
    return raiz;
  }
  const empacotar = (extra) => empacotarBackend({ raiz: raizCom(extra), saida: path.join(tmp(), 'p') });
  const codigo = (extra) => { try { empacotar(extra); return null; } catch (e) { return e.codigo; } };

  test('nomes de arquivo de segredo são recusados em qualquer caixa', () => {
    for (const nome of ['CREDENTIALS.js', 'Credentials.json', 'SECRETS.json', 'Secret.YAML', 'KEY.PEM', 'Cert.P12', 'ID_RSA', 'Id_Ed25519.pub', 'CHAVE.KEY', '.ENV', '.Env.Production', '.NPMRC', '.PgPass']) {
      assert.equal(codigo({ [`src/${nome}`]: 'x' }), 'SEGREDO_ARQUIVO', nome);
    }
  });

  test('literais atribuídos a nomes de segredo: curtos com símbolos, só letras longos e frases com hífen são recusados', () => {
    const suspeitos = [
      '{"PASSWORD":"Abc123!"}', "const password = 'abcdefghijklmnopqrstuvwxyz';", "const senha = 'correct-horse-battery';", 'const token = "p@ssw0rd!x";',
      "const PASSPHRASE = 'Zx9kLm2PqRt7';", "module.exports = { credential: 'a1b2c3d4e5' };", "const API_KEY = 'AbCdEfGhIjKlMn';", "const pwd = 'S3nh@Forte';",
    ];
    for (const c of suspeitos) assert.equal(codigo({ 'src/config/x.js': `${c}\n` }), 'SEGREDO_NO_CONTEUDO', c);
  });

  test('constantes, caminhos de campo e textos curtos legítimos não são recusados', () => {
    const legitimos = [
      "const ACAO = 'portal_recuperacao_senha';", "const x = { SENHA_CURTA: 'SENHA_CURTA' };", "const CAMPO_SENHA_PROVISORIA = 'body.senhaProvisoria';",
      "const senha = 'curta';", "const token = '';", "const TOKEN_SEM_CONSULTAR = 'TOKEN_SEM_CONSULTAR';",
    ];
    for (const c of legitimos) assert.equal(codigo({ 'src/config/x.js': `${c}\n` }), null, c);
  });

  test('o backend real continua empacotável com as regras novas', () => {
    const r = empacotarBackend({ raiz: path.join(REPO, 'backend'), saida: path.join(tmp(), 'real') });
    assert.ok(r.arquivos.length > 100);
  });
});

// ===================================================================================== overrides

describe('Overrides efetivamente usados ficam registrados, sem valores sensíveis', () => {
  const ultimoEvento = (amb, c) => estadoDe(amb, c).historico.at(-1);
  const nomes = (ev) => (ev.excecoes || []).map((x) => x.nome).sort();
  function criarReleaseRetro(n) {
    const dir = criarRelease({ n });
    const arq = path.join(dir, 'release.json');
    const r = lerJson(arq);
    fs.writeFileSync(arq, JSON.stringify({ ...r, rotulo: `${r.rotulo}-retroativo`, atual: false }));
    return dir;
  }

  test('downgrade registra permitirAnterior só quando houve downgrade', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    await instalarDir(amb, 'portal', criarRelease({ n: 3 }), criarDeps(amb).deps, { permitirAnterior: true });
    assert.deepEqual(nomes(ultimoEvento(amb, 'portal')), [], 'flag ligada mas sem uso: nada registrado');
    await instalarDir(amb, 'portal', criarRelease({ n: 1 }), criarDeps(amb).deps, { permitirAnterior: true });
    const ev = ultimoEvento(amb, 'portal');
    assert.deepEqual(nomes(ev), ['permitirAnterior']);
    assert.deepEqual([ev.excecoes[0].de, ev.excecoes[0].para], [R(3), R(1)]);
    assert.ok(diarioDe(amb, 'portal').find((p) => p.passo === 'INICIO' && p.para === R(1)).excecoes.includes('permitirAnterior'));
  });

  test('retroativo, sem autenticação, atual divergente e sem prova de versão são registrados quando usados', async () => {
    const amb = criarAmbiente();
    await instalarDir(amb, 'portal', criarReleaseRetro(1), criarDeps(amb).deps, { permitirRetroativo: true, semAutenticacao: true, releaseSha256Esperado: undefined });
    assert.deepEqual(nomes(ultimoEvento(amb, 'portal')), ['permitirRetroativo', 'semAutenticacao']);
    const raiz = path.join(amb.releases('portal'), `${R(1)}-retroativo`);
    fs.chmodSync(raiz, 0o755); fs.chmodSync(path.join(raiz, 'index.html'), 0o644); fs.appendFileSync(path.join(raiz, 'index.html'), 'adulterado');
    await instalarDir(amb, 'portal', criarRelease({ n: 3 }), criarDeps(amb).deps, { permitirAtualDivergente: true });
    const ev = ultimoEvento(amb, 'portal');
    assert.deepEqual(nomes(ev), ['permitirAtualDivergente']);
    assert.ok(ev.excecoes[0].problemas >= 1);
    const amb2 = criarAmbiente();
    const { deps } = criarDeps(amb2, { identificarProcesso: undefined });
    await instalarBackend(amb2, 1, deps, { semComprovacaoDeVersao: true });
    assert.deepEqual(nomes(ultimoEvento(amb2, 'backend')), ['semComprovacaoDeVersao']);
  });

  test('execução como root registrada quando efetiva; o registro não carrega valores sensíveis', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1 });
    await instalarDir(amb, 'portal', dir, criarDeps(amb).deps, { permitirRootEfetivo: true });
    const ev = ultimoEvento(amb, 'portal');
    assert.deepEqual(nomes(ev), ['permitirRoot']);
    const texto = JSON.stringify(ev.excecoes);
    assert.ok(!texto.includes(aprovado(dir)), 'o hash aprovado não é repetido nas exceções');
    assert.ok(!texto.includes(amb.raiz), 'nenhum caminho do servidor nas exceções');
  });

  test('a evidência da consulta é a da leitura mais recente, exposta junto de cada leitura (hash e número)', async () => {
    const { criarConsultaPorArquivo } = inst();
    const dir = tmp();
    const arq = path.join(dir, 'coord.json');
    const grava = (o) => fs.writeFileSync(arq, JSON.stringify(o), { mode: 0o600 });
    grava({ situacao: 'LIVRE', origem: 'a', consultadoEm: new Date().toISOString() });
    const { evidenciaDe } = require(path.join(REPO, 'deploy', 'hml', 'instalador', 'coordenacao.js'));
    const consultar = criarConsultaPorArquivo(arq);
    assert.equal(consultar.ultimaEvidencia, undefined, 'nada fica guardado na função de consulta');
    const primeiro = await consultar();
    const primeira = evidenciaDe(primeiro);
    grava({ situacao: 'OCUPADO', origem: 'b' });
    const lido = await consultar();
    assert.equal(lido.situacao, 'OCUPADO');
    assert.deepEqual(evidenciaDe(lido), { sha256: sha256(fs.readFileSync(arq)), leitura: 2 });
    assert.notEqual(primeira.sha256, evidenciaDe(lido).sha256);
    assert.equal(evidenciaDe(primeiro).leitura, 1, 'a evidência da primeira leitura continua sendo a dela');
    assert.deepEqual(Object.keys(lido).sort(), ['origem', 'situacao'], 'a evidência não aparece como campo do estado');
  });

  // T06: o rastro tem de citar a consulta que de fato decidiu cada ação, não uma anterior.
  async function arquivoQueMuda(amb, quantasLivres) {
    const { criarConsultaPorArquivo } = inst();
    const dir = tmp();
    const arq = path.join(dir, 'coord.json');
    let n = 0;
    const base = criarConsultaPorArquivo(arq);
    const grava = () => { n += 1; fs.writeFileSync(arq, JSON.stringify({ situacao: 'LIVRE', origem: `sintetica-${n}`, consultadoEm: new Date(AGORA0).toISOString() }), { mode: 0o600 }); };
    const consultar = async () => { grava(); return base(); };
    void amb; void quantasLivres;
    return { consultar, leituras: () => n, arquivo: arq };
  }

  test('rastro da instalação: o evento cita a consulta final que autorizou o reinício, com o hash do conteúdo lido nela', async () => {
    const amb = criarAmbiente();
    const f = await arquivoQueMuda(amb);
    const { deps } = criarDeps(amb, { consultarCoordenacao: f.consultar });
    await instalarBackend(amb, 1, deps);
    const ev = estadoDe(amb, 'backend').historico.at(-1);
    assert.equal(ev.evento, 'INSTALACAO');
    assert.equal(ev.coordenacao.fonte.leitura, f.leituras(), 'a última leitura é a que decidiu (a do reinício)');
    assert.equal(ev.coordenacao.fonte.sha256, sha256(fs.readFileSync(f.arquivo)));
    assert.equal(ev.coordenacao.origem, `sintetica-${f.leituras()}`);
  });

  test('rastro do rollback: o evento cita a consulta que autorizou o reinício de volta, não a que precedeu a falha (sonda do Codex)', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const f = await arquivoQueMuda(amb);
    const { deps } = criarDeps(amb, { consultarCoordenacao: f.consultar, reiniciar: (() => { let k = 0; return async () => { k += 1; if (k === 1) throw new Error('falha do reinício da nova'); }; })() });
    const e = await falha(instalarBackend(amb, 2, deps));
    assert.equal(e.codigo, 'REINICIO_FALHOU');
    const ev = estadoDe(amb, 'backend').historico.at(-1);
    assert.equal(ev.evento, 'REVERSAO_AUTOMATICA');
    assert.equal(ev.coordenacao.fonte.leitura, f.leituras(), `a evidência do rollback é a última leitura (${f.leituras()})`);
    assert.equal(ev.coordenacao.fonte.sha256, sha256(fs.readFileSync(f.arquivo)));
  });

  test('rastro do rollback bloqueado por coordenação: o evento cita a consulta que bloqueou', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const { criarConsultaPorArquivo } = inst();
    const dir = tmp();
    const arq = path.join(dir, 'coord.json');
    fs.writeFileSync(arq, JSON.stringify({ situacao: 'LIVRE', origem: 'livre', consultadoEm: new Date(AGORA0).toISOString() }), { mode: 0o600 });
    const consultar = criarConsultaPorArquivo(arq);
    const { deps } = criarDeps(amb, {
      consultarCoordenacao: consultar,
      reiniciar: async () => { fs.writeFileSync(arq, JSON.stringify({ situacao: 'OCUPADO', origem: 'backup-iniciou' }), { mode: 0o600 }); throw new Error('falha'); },
    });
    const dir2 = criarBackend({ n: 2 });
    const e = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir2, opcoes: opc(dir2), deps }));
    assert.equal(e.codigo, 'ROLLBACK_BLOQUEADO');
    const ev = estadoDe(amb, 'backend').historico.at(-1);
    assert.equal(ev.evento, 'ROLLBACK_BLOQUEADO');
    assert.equal(ev.coordenacao.situacao, 'OCUPADO');
    assert.equal(ev.coordenacao.fonte.sha256, sha256(fs.readFileSync(arq)));
  });

  test('o rastro nunca divulga o conteúdo da consulta, só o estado decidido, a origem e o hash', async () => {
    const amb = criarAmbiente();
    const f = await arquivoQueMuda(amb);
    const { deps } = criarDeps(amb, { consultarCoordenacao: f.consultar });
    await instalarBackend(amb, 1, deps);
    const ev = estadoDe(amb, 'backend').historico.at(-1);
    assert.deepEqual(Object.keys(ev.coordenacao).sort(), ['atestadoManual', 'consultadoEm', 'fonte', 'origem', 'situacao']);
    assert.deepEqual(Object.keys(ev.coordenacao.fonte).sort(), ['leitura', 'sha256']);
  });
});

// ===================================================================================== Nginx

describe('Nginx: limites de REDE_VERIFICACAO, HSTS e variantes de /api/plataforma', () => {
  const { PLACEHOLDERS, renderizarModelo } = require(NGINX);

  test('REDE_VERIFICACAO aceita só IP único ou rede estreita (IPv4 a partir de /24, IPv6 a partir de /64) e valida os endereços de verdade', () => {
    for (const v of ['203.0.113.7', '203.0.113.0/24', '203.0.113.7/32', '2001:db8::1', '2001:db8:0:1::/64', '2001:db8::1/128']) assert.equal(PLACEHOLDERS.REDE_VERIFICACAO(v), true, v);
    for (const v of ['10.0.0.0/8', '172.16.0.0/12', '10.20.0.0/16', '203.0.113.0/23', '2001:db8::/32', '2001:db8::/48', '1:2:3', '1:2:3:4:5:6:7:8:9', '2001:db8::zz', '999.1.1.1', '0.0.0.0', '::', '::/0', '203.0.113.0/', '203.0.113.0/033']) assert.equal(PLACEHOLDERS.REDE_VERIFICACAO(v), false, v);
  });

  test('HSTS_MAX_AGE não pode desligar nem reduzir a proteção a quase nada', () => {
    for (const v of ['0', '1', '60', '299']) assert.equal(PLACEHOLDERS.HSTS_MAX_AGE(v), false, v);
    for (const v of ['300', '86400', '63072000']) assert.equal(PLACEHOLDERS.HSTS_MAX_AGE(v), true, v);
    assert.equal(PLACEHOLDERS.HSTS_MAX_AGE('63072001'), false);
  });

  test('o Portal nega o namespace /api/plataforma em qualquer caixa, com ou sem barra final, usando a URI normalizada', () => {
    const modelo = fs.readFileSync(path.join(REPO, 'deploy', 'hml', 'nginx', 'portal.conf.modelo'), 'utf8');
    const bloco = /location \^~ \/api\/ \{([\s\S]*?)\n    \}/.exec(modelo);
    assert.ok(bloco, 'location ^~ /api/ existe');
    assert.match(bloco[1], /if \(\$uri ~\* "\^\/api\/plataforma\(\/\|\$\)"\) \{\s*return 404;\s*\}/);
    assert.ok(bloco[1].indexOf('return 404') < bloco[1].indexOf('proxy_pass'), 'a negação vem antes do proxy');
    renderizarModelo(modelo, VALORES_NGINX);
  });

  test('o Painel só encaminha o namespace exato; qualquer outra variante de /api/ responde 404', () => {
    const modelo = fs.readFileSync(path.join(REPO, 'deploy', 'hml', 'nginx', 'painel.conf.modelo'), 'utf8');
    assert.equal((modelo.match(/proxy_pass/g) || []).length, 1);
    assert.match(modelo, /location \^~ \/api\/plataforma\/ \{[\s\S]*?proxy_pass/);
    assert.match(modelo, /location \^~ \/api\/ \{\s*return 404;\s*\}/);
  });
});
const VALORES_NGINX = {
  DOMINIO_PORTAL: 'portal.exemplo.com.br', DOMINIO_PAINEL: 'painel.exemplo.com.br', RAIZ_PORTAL: '/var/www/hml/portal', RAIZ_PAINEL: '/var/www/hml/painel',
  ARQUIVO_VERSAO_PORTAL: '/var/www/hml/.releases/portal/versao.json', ARQUIVO_VERSAO_PAINEL: '/var/www/hml/.releases/painel/versao.json',
  ARQUIVO_SEGURANCA_PORTAL: '/etc/nginx/hml/seguranca-portal.conf', ARQUIVO_SEGURANCA_PAINEL: '/etc/nginx/hml/seguranca-painel.conf',
  PORTA_BACKEND: '3000', LIMITE_CORPO: '10m', HSTS_MAX_AGE: '300', CERTIFICADO_PORTAL: '/etc/ssl/exemplo/portal.pem', CHAVE_PORTAL: '/etc/ssl/exemplo/portal.key',
  CERTIFICADO_PAINEL: '/etc/ssl/exemplo/painel.pem', CHAVE_PAINEL: '/etc/ssl/exemplo/painel.key', DESTINO_RAIZ_PORTAL: '/index.html', DESTINO_RAIZ_PAINEL: '/index.html',
  CSP_PORTAL: "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'",
  CSP_PAINEL: "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'",
  RAIZ_ACME: '/var/www/acme', REDE_VERIFICACAO: '203.0.113.0/24',
};

// ===================================================================================== backend bloqueado

describe('O backend segue bloqueado sem coordenação homologada: o atestado não libera', () => {
  const { avaliarCoordenacao } = require(COORD);

  test('DESCONHECIDO nunca libera o backend, nem com atestado', () => {
    for (const atestado of [true, false]) {
      const r = avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'DESCONHECIDO', origem: 'sem trava' }, atestado });
      assert.equal(r.ok, false);
      assert.equal(r.atestadoManual, false);
      assert.equal(r.bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    }
  });

  test('instalar o backend com atestado e coordenação desconhecida é recusado sem reinício', async () => {
    const amb = criarAmbiente();
    const { deps, chamadas } = criarDeps(amb, { consultarCoordenacao: async () => ({ situacao: 'DESCONHECIDO', origem: 'sem trava' }) });
    const e = await falha(instalarBackend(amb, 1, deps, { atestarSemOperacao: true }));
    assert.equal(e.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    assert.equal(chamadas.reiniciar, 0);
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('o rollback também não é liberado por atestado quando a coordenação some', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    let desconhecido = false;
    const dir2 = criarBackend({ n: 2 });
    const e = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir2, opcoes: opc(dir2, { atestarSemOperacao: true }), deps: criarDeps(amb, {
      consultarCoordenacao: async () => (desconhecido ? { situacao: 'DESCONHECIDO', origem: 'sem trava' } : { situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date(AGORA0).toISOString() }),
      reiniciar: async () => { desconhecido = true; throw new Error('falha'); },
    }).deps }));
    assert.equal(e.codigo, 'ROLLBACK_BLOQUEADO');
  });

  test('linha de comando: instalar ou reverter backend é recusado enquanto não houver provedor homologado; a flag de atestado é rejeitada', () => {
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config), { mode: 0o600 });
    const dir = criarBackend({ n: 1 });
    const rodar = (...a) => spawnSync(process.execPath, [MODULO, ...a], { encoding: 'utf8' });
    const obsArq = path.join(tmp(), 'obs.json');
    fs.writeFileSync(obsArq, JSON.stringify(observadoDe('000_a.sql')), { mode: 0o600 });
    const coordArq = path.join(tmp(), 'coord.json');
    fs.writeFileSync(coordArq, JSON.stringify({ situacao: 'LIVRE', origem: 'arquivo', consultadoEm: new Date().toISOString() }), { mode: 0o600 });
    for (const cmd of [['instalar', '--release', dir, '--release-sha256', aprovado(dir)], ['reverter']]) {
      const r = rodar(cmd[0], '--config', cfg, '--componente', 'backend', ...cmd.slice(1), '--observado', obsArq, '--coordenacao', coordArq);
      assert.equal(r.status, 1, cmd[0]);
      assert.match(r.stderr, /COORDENACAO_NAO_HOMOLOGADA/, cmd[0]);
    }
    const atesto = rodar('instalar', '--config', cfg, '--componente', 'backend', '--release', dir, '--release-sha256', aprovado(dir), '--atesto-sem-operacao-de-backup');
    assert.equal(atesto.status, 1);
    assert.match(atesto.stderr, /ATESTADO_NAO_LIBERA_BACKEND/);
    assert.equal(existeLink(amb.link('backend')), false);
  });

  const SO_LINUX = process.platform === 'linux' ? false : 'a linha de comando exige a âncora real /proc/self/fd (Linux); executa no CI';
  test('linha de comando: o frontend instala normalmente onde existe a âncora real (Linux)', { skip: SO_LINUX }, () => {
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config), { mode: 0o600 });
    const dir = criarRelease({ n: 1 });
    const r = spawnSync(process.execPath, [MODULO, 'instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', aprovado(dir)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('linha de comando fora do Linux: a instalação do frontend é bloqueada (PLATAFORMA_SEM_ANCORA) e nada é criado', { skip: process.platform === 'linux' ? 'só vale fora do Linux' : false }, () => {
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config), { mode: 0o600 });
    const dir = criarRelease({ n: 1 });
    const r = spawnSync(process.execPath, [MODULO, 'instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', aprovado(dir)], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PLATAFORMA_SEM_ANCORA/);
    assert.equal(fs.existsSync(path.join(amb.www, '.releases')), false);
  });
});

// ===================================================================================== âncoras

describe('B01 — as âncoras: troca de diretório detectada, ordem de publicação e identidade de cada arquivo', () => {
  test('diretório operacional trocado por outro diretório real, no mesmo caminho, depois de aberto: a próxima operação é recusada e nada é gravado', () => {
    const A = criarAncoraPorCaminho({});
    const raiz = tmp();
    fs.mkdirSync(path.join(raiz, 'd'));
    const base = A.abrirBase(raiz);
    const d = A.abrirFilho(base, 'd');
    A.escreverAtomico(d, 'a.txt', '1');
    fs.renameSync(path.join(raiz, 'd'), path.join(raiz, 'd.orig'));
    fs.mkdirSync(path.join(raiz, 'd'));
    assert.throws(() => A.escreverAtomico(d, 'b.txt', '2'), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(fs.readdirSync(path.join(raiz, 'd')), []);
    assert.deepEqual(fs.readdirSync(path.join(raiz, 'd.orig')), ['a.txt']);
    A.fecharTudo();
  });

  test('a âncora por caminho exige reconhecimento explícito, e a padrão recusa quando não há /proc (nunca degrada sozinha)', () => {
    const { criarAncora } = require(path.join(REPO, 'deploy', 'hml', 'instalador', 'ancora.js'));
    assert.throws(() => criarAncora({ modo: 'caminho' }), (e) => e.codigo === 'ANCORA_SEM_GARANTIA_NAO_RECONHECIDA');
    assert.throws(() => criarAncora({ modo: 'inventado' }), (e) => e.codigo === 'ANCORA_MODO_INVALIDO');
    if (process.platform !== 'linux') assert.throws(() => criarAncora({}), (e) => e.codigo === 'PLATAFORMA_SEM_ANCORA');
    else assert.equal(criarAncora({}).modo, 'proc');
  });

  test('arquivo do preparo trocado por outro de mesmo conteúdo (outro inode) durante a espera é recusado', async () => {
    const amb = criarAmbiente();
    const dir = criarBackend({ n: 1 });
    const { deps } = criarDeps(amb, {
      executar: async (cmd, args, o) => {
        const alvo = path.join(o.cwd, 'package.json');
        const conteudo = fs.readFileSync(alvo);
        // O inode original fica ABERTO enquanto o substituto é criado. Em ext4 (CI, Linux) um inode recém-liberado é
        // reaproveitado na hora e o substituto nascia com o MESMO número, o que não é a troca que este teste descreve; em
        // APFS isso não acontece. Com o descritor aberto o kernel nunca reaproveita, e a precondição é conferida.
        const original = fs.openSync(alvo, 'r');
        try {
          fs.rmSync(alvo);
          fs.writeFileSync(alvo, conteudo);
          assert.notEqual(fs.statSync(alvo).ino, fs.fstatSync(original).ino, 'precondição: o substituto precisa ser outro inode');
        } finally {
          fs.closeSync(original);
        }
      },
    });
    const e = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps }));
    assert.equal(e.codigo, 'INTEGRIDADE_DIVERGENTE');
    assert.equal(existeLink(amb.link('backend')), false);
    assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => n === R(1)), []);
  });

  test('um diretório de release criado e removido não deixa .trava nem preparo para trás', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    assert.deepEqual(fs.readdirSync(amb.releases('portal')).filter((n) => n === '.trava' || n.startsWith('.preparo-')), []);
  });
});
