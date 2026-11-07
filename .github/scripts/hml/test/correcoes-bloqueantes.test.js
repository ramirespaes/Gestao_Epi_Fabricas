'use strict';

process.env.NODE_ENV = 'test';

/**
 * Correção dos bloqueantes F1 a F10 da quarta auditoria independente do Codex (contraprovas sintéticas):
 *   F1 hardlink no diário e em arquivos alterados no lugar      F6 destino efetivo do ponteiro
 *   F2 node_modules redirecionado (npm ci apaga o destino)      F7 diário ilegível bloqueia integridade e operações
 *   F3 remoção de diretório substituído                         F8 aviso de durabilidade em toda operação
 *   F4 troca concorrente de ancestrais da base                  F9 evidência de coordenação isolada por operação
 *   F5 árvore publicada igual à árvore verificada               F10 bloqueio do backend na biblioteca e âncoras de teste
 *
 * Provas locais usam a âncora por caminho (sem garantia de corrida, só em NODE_ENV=test) e um MODELO do /proc/self/fd
 * que também acompanha a movimentação de diretórios já abertos. O modelo prova a lógica do algoritmo, nunca o
 * comportamento do kernel: tudo o que depende de resolução real do Linux está em testes marcados skip fora do Linux.
 * Nenhum teste aqui executa o npm real: o npm ci apaga o destino de um node_modules que seja link, então a
 * reprodução com o npm real fica fora desta suíte (ver docs, validação obrigatória em Linux isolado).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Correção arquitetural da terceira auditoria independente do Codex (T01 a T06): sem process.chdir, âncoras
 * por descritor, durabilidade por operação, política de operações por componente e rastro da consulta final.
 *
 * O que estes testes provam localmente e o que exige Linux real:
 *  - qualquer plataforma: a política, a durabilidade por operação, a ausência de chdir, a conferência de identidade da
 *    release publicada, e toda a LÓGICA do modo 'proc' (rodada contra um emulador de /proc/self/fd, com a propriedade de
 *    que nenhuma mutação usa um caminho remontado);
 *  - só Linux (marcados skip aqui, executados no CI): a resolução real pelo kernel de /proc/self/fd contra trocas
 *    concorrentes de diretório, o cwd do processo externo e a E/S pendente.
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

// ------------------------------------------------------------------ auxiliares desta rodada

const ANCORA = path.join(REPO, 'deploy', 'hml', 'instalador', 'ancora.js');
const { criarAncora } = require(ANCORA);
const LINUX = process.platform === 'linux';
const SO_LINUX = LINUX ? false : 'exige a âncora real /proc/self/fd (Linux); executa no CI';

// Emulador de /proc/self/fd/<n>/<nome> para plataformas sem /proc: traduz o caminho pelo diretório registrado no
// momento da abertura e registra toda mutação do sistema de arquivos. Não substitui o kernel (a resolução real contra
// trocas concorrentes só se prova no Linux), mas executa a lógica inteira do modo 'proc' e prova que nenhuma mutação
// usa um caminho remontado.
function criarFsEmulado() {
  const caminhos = new Map();
  const mutacoes = [];
  const RE = /^\/proc\/(?:self|\d+)\/fd\/(\d+)(\/.*)?$/;
  const traduzir = (p) => {
    if (typeof p !== 'string') return p;
    const m = RE.exec(p);
    if (!m) return p;
    const base = caminhos.get(Number(m[1]));
    if (base === undefined) throw Object.assign(new Error('descritor desconhecido no emulador'), { code: 'ENOENT' });
    return base + (m[2] || '');
  };
  const registrar = (fn, p) => mutacoes.push({ fn, caminho: String(p) });
  const emulado = new Proxy(fs, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      if (nome === 'openSync') {
        return (p, flags, modo) => {
          const escrita = typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
          if (escrita) registrar('openSync', p);
          const real = traduzir(p);
          const fd = alvo.openSync(real, flags, modo);
          if (alvo.fstatSync(fd).isDirectory()) caminhos.set(fd, real);
          return fd;
        };
      }
      if (nome === 'closeSync') return (fd) => { caminhos.delete(fd); return alvo.closeSync(fd); };
      return (...args) => {
        if (['mkdirSync', 'unlinkSync', 'rmdirSync', 'renameSync'].includes(nome)) { registrar(nome, args[0]); if (nome === 'renameSync') registrar(nome, args[1]); }
        if (nome === 'symlinkSync' || nome === 'copyFileSync') registrar(nome, args[1]);
        return valor.apply(alvo, args.map(traduzir));
      };
    },
  });
  return { fs: emulado, mutacoes };
}
const fabricaEmulada = (emu) => (op) => criarAncora({ ...op, modo: 'proc', fsImpl: emu.fs });
const executarDoPreparo = async (cmd, args, o) => {
  const nm = path.join(o.caminho || o.cwd, 'node_modules', 'zod');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'i.js'), '1');
};


// ------------------------------------------------------------------ modelo do /proc com movimentação de diretórios

// Como criarFsEmulado, mas os diretórios abertos ACOMPANHAM uma renomeação (como um descritor segue o inode). `mover`
// faz a troca que um escritor concorrente faria e atualiza os descritores registrados.
function criarFsModelo() {
  const dirs = new Map();
  const mutacoes = [];
  const RE = /^\/proc\/(?:self|\d+)\/fd\/(\d+)(\/.*)?$/;
  const tr = (p) => {
    if (typeof p !== 'string') return p;
    const m = RE.exec(p);
    if (!m) return p;
    if (!dirs.has(Number(m[1]))) throw Object.assign(new Error('descritor desconhecido no modelo'), { code: 'ENOENT' });
    return dirs.get(Number(m[1])) + (m[2] || '');
  };
  function mover(a, b) {
    const de = tr(a); const para = tr(b);
    fs.renameSync(de, para);
    for (const [fd, p] of dirs) if (p === de || p.startsWith(`${de}/`)) dirs.set(fd, para + p.slice(de.length));
  }
  const registrar = (nome, p) => mutacoes.push({ nome, caminho: String(p) });
  const modelo = new Proxy(fs, {
    get(alvo, nome) {
      const v = alvo[nome];
      if (typeof v !== 'function') return v;
      if (nome === 'openSync') {
        return (p, flags, modo) => {
          const real = tr(p);
          const fd = alvo.openSync(real, flags, modo);
          if (alvo.fstatSync(fd).isDirectory()) dirs.set(fd, path.posix.normalize(real));
          return fd;
        };
      }
      if (nome === 'closeSync') return (fd) => { dirs.delete(fd); return alvo.closeSync(fd); };
      if (nome === 'renameSync') return (a, b) => { registrar('renameSync', a); mover(a, b); };
      return (...args) => {
        if (['mkdirSync', 'unlinkSync', 'rmdirSync', 'symlinkSync', 'copyFileSync'].includes(nome)) registrar(nome, args[nome === 'symlinkSync' || nome === 'copyFileSync' ? 1 : 0]);
        return v.apply(alvo, args.map(tr));
      };
    },
  });
  return { fs: modelo, mover, mutacoes };
}
const fabricaModelo = (m) => (op) => criarAncora({ ...op, modo: 'proc', fsImpl: m.fs });
const dadosPersistentes = (amb) => arvore(amb.data);

// ===================================================================================== F1

describe('F1 — hardlink: o mesmo inode de outro caminho nunca é lido, gravado nem alterado por este nome', () => {
  test('diário que é hardlink de um arquivo persistente: a operação é recusada e o persistente fica byte a byte igual', async () => {
    const amb = criarAmbiente();
    const vitima = path.join(amb.data, 'log-protegido');
    fs.writeFileSync(vitima, '{}\n');
    fs.mkdirSync(amb.releases('portal'), { recursive: true });
    fs.linkSync(vitima, path.join(amb.releases('portal'), 'diario.jsonl'));
    const antes = fs.readFileSync(vitima);
    const e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps));
    assert.ok(['DIARIO_ILEGIVEL', 'DIARIO_INVALIDO'].includes(e.codigo), e.codigo);
    assert.deepEqual(fs.readFileSync(vitima), antes);
    assert.equal(fs.statSync(vitima).nlink, 2);
    assert.equal(existeLink(amb.link('portal')), false);
  });

  test('anexar recusa um diário com mais de um link, sem gravar nada', () => {
    const A = criarAncoraPorCaminho({});
    const pai = tmp();
    const base = A.abrirBase(pai);
    const vitima = path.join(pai, 'persistente');
    fs.writeFileSync(vitima, 'dado\n');
    fs.linkSync(vitima, path.join(pai, 'diario.jsonl'));
    assert.throws(() => A.anexar(base, 'diario.jsonl', '{"x":1}\n'), (e) => e.codigo === 'DIARIO_INVALIDO' && /links/.test(e.message));
    assert.equal(fs.readFileSync(vitima, 'utf8'), 'dado\n');
    A.fecharTudo();
  });

  test('anexar cria o diário de forma exclusiva e anexa nos seguintes', () => {
    const A = criarAncoraPorCaminho({});
    const pai = tmp();
    const base = A.abrirBase(pai);
    A.anexar(base, 'diario.jsonl', 'a\n');
    A.anexar(base, 'diario.jsonl', 'b\n');
    assert.equal(fs.readFileSync(path.join(pai, 'diario.jsonl'), 'utf8'), 'a\nb\n');
    assert.equal(fs.statSync(path.join(pai, 'diario.jsonl')).mode & 0o777, 0o600);
    A.fecharTudo();
  });

  test('alterar permissões e ler por um nome que é hardlink são recusados (o chmod não atinge o outro caminho)', () => {
    const A = criarAncoraPorCaminho({});
    const pai = tmp();
    const base = A.abrirBase(pai);
    const vitima = path.join(pai, 'persistente');
    fs.writeFileSync(vitima, 'dado', { mode: 0o644 });
    fs.linkSync(vitima, path.join(pai, 'copia'));
    assert.throws(() => A.comArquivo(base, 'copia', (a) => a.chmod(0o444)), (e) => e.codigo === 'ARQUIVO_COMPARTILHADO');
    assert.throws(() => A.lerBytes(base, 'copia'), (e) => e.codigo === 'ARQUIVO_COMPARTILHADO');
    assert.equal(fs.statSync(vitima).mode & 0o777, 0o644);
    assert.doesNotThrow(() => A.comArquivo(base, 'copia', (a) => a.sincronizar(), { exigirLinkUnico: false }));
    A.fecharTudo();
  });

  test('arquivo copiado para o preparo que ganha um hardlink antes da finalização não é alterado (chmod recusado)', async () => {
    const amb = criarAmbiente();
    const vitima = path.join(amb.data, 'espelho');
    fs.writeFileSync(vitima, '<p>v1</p>', { mode: 0o644 });
    const { deps } = criarDeps(amb, {
      criarAncora: (op) => {
        const A = criarAncoraPorCaminho(op);
        const copiar = A.copiarArquivo;
        A.copiarArquivo = (origem, dir, nome) => {
          const r = copiar(origem, dir, nome);
          if (nome === 'index.html') { fs.unlinkSync(path.join(dir.caminho, nome)); fs.linkSync(vitima, path.join(dir.caminho, nome)); return { ...r, ino: fs.statSync(vitima).ino }; }
          return r;
        };
        return A;
      },
    });
    const e = await falha(instalarPortal(amb, 1, deps));
    assert.ok(['INTEGRIDADE_DIVERGENTE', 'ARQUIVO_COMPARTILHADO'].includes(e.codigo), e.codigo);
    assert.equal(fs.statSync(vitima).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(vitima, 'utf8'), '<p>v1</p>');
  });
});

// ===================================================================================== F2

describe('F2 — node_modules: nunca existe antes do npm e, depois, é uma árvore própria', () => {
  const plantarLinkDepoisDaCopia = (amb, destino) => (op) => {
    const A = criarAncoraPorCaminho(op);
    const copiar = A.copiarArquivo;
    let feito = false;
    A.copiarArquivo = (origem, dir, nome) => {
      const r = copiar(origem, dir, nome);
      if (!feito && dir.caminho.includes('.preparo-')) { feito = true; fs.symlinkSync(destino, path.join(dir.caminho.split('/').slice(0, dir.caminho.split('/').findIndex((p) => p.startsWith('.preparo-')) + 1).join('/'), 'node_modules')); }
      return r;
    };
    return A;
  };

  test('node_modules já existente (link para o persistente) no preparo: o npm NÃO é executado e o persistente fica intacto', async () => {
    const amb = criarAmbiente();
    fs.writeFileSync(path.join(amb.data, 'preserve-me'), 'sentinela sintética');
    const antes = dadosPersistentes(amb);
    let executou = 0;
    const { deps } = criarDeps(amb, { criarAncora: plantarLinkDepoisDaCopia(amb, amb.data), executar: async () => { executou += 1; } });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'NODE_MODULES_PREEXISTENTE');
    assert.equal(executou, 0);
    assert.deepEqual(dadosPersistentes(amb), antes);
    assert.equal(existeLink(amb.link('backend')), false);
    assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => n.startsWith('.preparo-') || n.startsWith('hml-')), [], 'nenhum preparo nem release ficou para trás');
  });

  test('node_modules criado como link durante o processo externo é recusado antes de qualquer publicação', async () => {
    const amb = criarAmbiente();
    fs.writeFileSync(path.join(amb.data, 'preserve-me'), 'sentinela sintética');
    const antes = dadosPersistentes(amb);
    const { deps } = criarDeps(amb, { executar: async (cmd, args, o) => { fs.symlinkSync(amb.data, path.join(o.caminho, 'node_modules')); } });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'DEPENDENCIAS_INSEGURAS');
    assert.deepEqual(dadosPersistentes(amb), antes);
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('um link dentro de node_modules que sai da árvore (absoluto ou com ..) é recusado; um link interno é aceito', async () => {
    for (const [alvo, ok] of [[() => '/etc', false], [() => '../../fora', false], [() => '../zod/i.js', true]]) {
      const amb = criarAmbiente();
      const { deps } = criarDeps(amb, {
        executar: async (cmd, args, o) => {
          fs.mkdirSync(path.join(o.caminho, 'node_modules', 'zod'), { recursive: true });
          fs.writeFileSync(path.join(o.caminho, 'node_modules', 'zod', 'i.js'), '1');
          fs.mkdirSync(path.join(o.caminho, 'node_modules', '.bin'), { recursive: true });
          fs.symlinkSync(alvo(), path.join(o.caminho, 'node_modules', '.bin', 'zod'));
        },
      });
      if (ok) assert.equal((await instalarBackend(amb, 1, deps)).resultado, 'INSTALADA');
      else assert.equal((await falha(instalarBackend(amb, 1, deps))).codigo, 'DEPENDENCIAS_INSEGURAS');
    }
  });

  test('depois de instalado, identificar reprova uma release cujo node_modules virou link', async () => {
    const amb = criarAmbiente();
    const { sim, deps } = simulador(amb, { executar: executarDoPreparo });
    await instalarDir(amb, 'backend', criarBackend({ n: 1 }), deps);
    assert.equal((await identificar(amb, 'backend')).integro, true);
    const rel = path.join(amb.releases('backend'), R(1));
    fs.chmodSync(rel, 0o755);
    fs.renameSync(path.join(rel, 'node_modules'), path.join(rel, 'node_modules.orig'));
    fs.symlinkSync(amb.data, path.join(rel, 'node_modules'));
    const id = await identificar(amb, 'backend');
    assert.equal(id.integro, false);
    assert.ok(id.problemas.some((p) => /node_modules/.test(p)), id.problemas.join('; '));
    await exigirNaoDivergir(amb, sim);
  });
});

// ===================================================================================== F3

describe('F3 — remoção: um diretório substituído nunca é esvaziado', () => {
  for (const [rotulo, criar] of [['âncora por caminho', () => ({ A: criarAncoraPorCaminho({}), mover: (a, b) => fs.renameSync(a, b) })], ['modelo do /proc', () => { const m = criarFsModelo(); return { A: fabricaModelo(m)({}), mover: (a, b) => m.mover(a, b) }; }]]) {
    test(`troca entre a conferência e a abertura (${rotulo}): a substituta sobrevive e a chamada falha`, () => {
      const { A } = criar();
      const raiz = tmp();
      const alvoDir = path.join(raiz, 'target');
      fs.mkdirSync(alvoDir);
      fs.writeFileSync(path.join(alvoDir, 'original'), 'preservar original');
      const base = A.abrirBase(raiz);
      const filho = A.abrirFilho(base, 'target');
      const identidade = A.identidade(filho);
      A.fechar(filho);
      const desarmar = armadilha('openSync', (p) => p.endsWith('/target'), () => {
        fs.renameSync(alvoDir, `${alvoDir}.saved`);
        fs.mkdirSync(alvoDir);
        fs.writeFileSync(path.join(alvoDir, 'outro-escritor'), 'nao remover');
      });
      try {
        assert.throws(() => A.removerArvore(base, 'target', { identidade }), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO');
      } finally { desarmar(); }
      assert.equal(fs.readFileSync(path.join(alvoDir, 'outro-escritor'), 'utf8'), 'nao remover');
      assert.equal(fs.readFileSync(path.join(`${alvoDir}.saved`, 'original'), 'utf8'), 'preservar original');
      A.fecharTudo();
    });
  }

  test('remoção sem identidade informada também só esvazia o diretório que o lstat viu', () => {
    const A = criarAncoraPorCaminho({});
    const raiz = tmp();
    const alvoDir = path.join(raiz, 'orfa');
    fs.mkdirSync(alvoDir);
    fs.writeFileSync(path.join(alvoDir, 'a'), '1');
    const base = A.abrirBase(raiz);
    const desarmar = armadilha('openSync', (p) => p.endsWith('/orfa'), () => {
      fs.renameSync(alvoDir, `${alvoDir}.saved`);
      fs.mkdirSync(alvoDir);
      fs.writeFileSync(path.join(alvoDir, 'de-terceiro'), 'nao remover');
    });
    try { assert.throws(() => A.removerArvore(base, 'orfa'), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO'); } finally { desarmar(); }
    assert.equal(fs.readFileSync(path.join(alvoDir, 'de-terceiro'), 'utf8'), 'nao remover');
    A.fecharTudo();
  });

  test('um diretório persistente movido para o nome da release antes da limpeza não é apagado', async () => {
    const amb = criarAmbiente();
    let preparoCaminho = null;
    const { deps } = criarDeps(amb, {
      executar: async (cmd, args, o) => {
        // falha do npm: a limpeza do preparo roda depois; antes disso o nome do preparo passa a ser o diretório persistente REAL
        preparoCaminho = o.caminho;
        fs.renameSync(o.caminho, `${o.caminho}.original`);
        fs.renameSync(amb.data, o.caminho);
        throw new Error('npm falhou de propósito');
      },
    });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'DEPENDENCIAS_FALHARAM');
    assert.equal(fs.readFileSync(path.join(preparoCaminho, 'imagens', 'a.png'), 'utf8'), 'png', 'o diretório persistente movido para o nome do preparo não foi esvaziado');
  });
});

// ===================================================================================== F4

describe('F4 — base: os ancestrais são atravessados e validados por descritor, não revalidados por caminho', () => {
  function ambienteComBaseProfunda() {
    const amb = criarAmbiente();
    const pai = path.join(amb.raiz, 'parent');
    const base = path.join(pai, 'base');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(amb.data, 'base'));
    amb.config.componentes.portal.base = base;
    return { amb, pai, base };
  }
  for (const [rotulo, fabrica] of [['âncora por caminho', () => criarAncoraPorCaminho], ['modelo do /proc', () => fabricaModelo(criarFsModelo())]]) {
    test(`ancestral trocado por link entre a canonicalização e a abertura (${rotulo}): nada é escrito no persistente`, async () => {
      const { amb, pai } = ambienteComBaseProfunda();
      const antes = dadosPersistentes(amb);
      const { deps } = criarDeps(amb, { criarAncora: fabrica() });
      const desarmar = armadilha('openSync', (p) => p.endsWith('/parent'), () => {
        fs.renameSync(pai, `${pai}.saved`);
        fs.symlinkSync(amb.data, pai);
      });
      let e;
      try { e = await falha(instalarPortal(amb, 1, deps)); } finally { desarmar(); }
      assert.ok(['CAMINHO_OPERACIONAL_INVALIDO', 'ANCESTRAL_NAO_CONFIAVEL'].includes(e.codigo), e.codigo);
      assert.deepEqual(dadosPersistentes(amb), antes);
      assert.equal(fs.existsSync(path.join(amb.data, 'base', '.releases')), false);
    });
  }

  test('troca de ancestral no instante da abertura do último componente (modos por caminho): o resultado é conferido e nada é escrito', async () => {
    const { amb, pai, base } = ambienteComBaseProfunda();
    const antes = dadosPersistentes(amb);
    const { deps } = criarDeps(amb);
    const desarmar = armadilha('openSync', (p) => p === base, () => {
      fs.renameSync(pai, `${pai}.saved`);
      fs.symlinkSync(amb.data, pai);
    });
    let e;
    try { e = await falha(instalarPortal(amb, 1, deps)); } finally { desarmar(); }
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.match(e.message, /substituído durante a abertura/);
    assert.deepEqual(dadosPersistentes(amb), antes);
    assert.equal(fs.existsSync(path.join(amb.data, 'base', '.releases')), false);
  });

  test('um ancestral gravável por grupo ou outros é recusado, e um ancestral de outro usuário também', () => {
    const { validarAncestral } = require(ANCORA);
    const dir = (uid, mode) => ({ isDirectory: () => true, uid, mode });
    assert.doesNotThrow(() => validarAncestral(dir(501, 0o40755), 501, 'a'));
    assert.doesNotThrow(() => validarAncestral(dir(0, 0o40755), 501, 'a'));
    assert.doesNotThrow(() => validarAncestral(dir(0, 0o41777), 501, '/tmp'), 'sticky de root, como /tmp');
    assert.throws(() => validarAncestral(dir(501, 0o40777), 501, 'a'), (e) => e.codigo === 'ANCESTRAL_NAO_CONFIAVEL');
    assert.throws(() => validarAncestral(dir(501, 0o40775), 501, 'a'), (e) => e.codigo === 'ANCESTRAL_NAO_CONFIAVEL');
    assert.throws(() => validarAncestral(dir(501, 0o41777), 501, 'a'), (e) => e.codigo === 'ANCESTRAL_NAO_CONFIAVEL', 'sticky de usuário comum não basta');
    assert.throws(() => validarAncestral(dir(777, 0o40755), 501, 'a'), (e) => e.codigo === 'ANCESTRAL_NAO_CONFIAVEL');
  });

  test('base cujo ancestral é gravável por outros: a abertura é recusada (nada é criado)', async () => {
    const { amb, pai } = ambienteComBaseProfunda();
    fs.chmodSync(pai, 0o777);
    const e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps));
    assert.equal(e.codigo, 'ANCESTRAL_NAO_CONFIAVEL');
    assert.equal(fs.existsSync(path.join(amb.www, '.releases')), false);
    assert.equal(fs.existsSync(path.join(pai, 'base', '.releases')), false);
  });

  test('caminho relativo como base é recusado', () => {
    assert.throws(() => criarAncoraPorCaminho({}).abrirBase('relativo/base'), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO');
  });
});

// ===================================================================================== F5

describe('F5 — a árvore publicada é a árvore verificada', () => {
  for (const [rotulo, montar] of [
    ['âncora por caminho', () => ({ fabrica: criarAncoraPorCaminho, mover: (a, b) => fs.renameSync(a, b) })],
    ['modelo do /proc', () => { const m = criarFsModelo(); return { fabrica: fabricaModelo(m), mover: (a, b) => m.mover(a, b) }; }],
  ]) {
    test(`subdiretório do preparo trocado por link para o persistente durante a espera pelas dependências (${rotulo}): a instalação NÃO é declarada concluída`, async () => {
      const amb = criarAmbiente();
      fs.writeFileSync(path.join(amb.data, 'server.js'), '// código não aprovado');
      const antes = dadosPersistentes(amb);
      const { fabrica, mover } = montar();
      const { deps } = criarDeps(amb, {
        criarAncora: fabrica,
        executar: async (cmd, args, o) => {
          const src = path.join(o.caminho, 'src');
          mover(src, `${src}.saved`);
          fs.symlinkSync(amb.data, src);
        },
      });
      const e = await falha(instalarBackend(amb, 1, deps));
      assert.ok(['INTEGRIDADE_DIVERGENTE', 'CAMINHO_OPERACIONAL_INVALIDO'].includes(e.codigo), e.codigo);
      assert.deepEqual(dadosPersistentes(amb), antes);
      assert.equal(existeLink(amb.link('backend')), false);
      assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => /^hml-|^\.preparo-/.test(n)), [], 'nada ficou publicado nem em preparo');
    });
  }

  test('subdiretório trocado por OUTRO diretório real com o mesmo conteúdo também é recusado (identidade, não conteúdo)', async () => {
    const amb = criarAmbiente();
    const m = criarFsModelo();
    const { deps } = criarDeps(amb, {
      criarAncora: fabricaModelo(m),
      executar: async (cmd, args, o) => {
        const src = path.join(o.caminho, 'src');
        m.mover(src, `${src}.saved`);
        fs.cpSync(`${src}.saved`, src, { recursive: true });
      },
    });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'INTEGRIDADE_DIVERGENTE');
    assert.match(e.message, /substituído/);
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('arquivo extra plantado no preparo e arquivo removido são recusados', async () => {
    for (const mexer of [(o) => fs.writeFileSync(path.join(o.caminho, 'src', 'extra.js'), '//'), (o) => fs.rmSync(path.join(o.caminho, 'src', 'server.js'))]) {
      const amb = criarAmbiente();
      const { deps } = criarDeps(amb, { executar: async (cmd, args, o) => { mexer(o); } });
      const e = await falha(instalarBackend(amb, 1, deps));
      assert.equal(e.codigo, 'INTEGRIDADE_DIVERGENTE');
      assert.equal(existeLink(amb.link('backend')), false);
    }
  });

  test('conteúdo alterado DEPOIS da publicação e antes de qualquer ponteiro: a verificação final por nome recusa e limpa', async () => {
    const amb = criarAmbiente();
    const antes = dadosPersistentes(amb);
    const { deps } = criarDeps(amb, {
      criarAncora: (op) => {
        const A = criarAncoraPorCaminho(op);
        const renomear = A.renomear;
        let alterou = false;
        A.renomear = (deDir, de, paraDir, para) => {
          renomear(deDir, de, paraDir, para);
          if (!alterou && de.startsWith('.preparo-')) {
            alterou = true;
            const publicada = path.join(paraDir.caminho, para);
            fs.chmodSync(path.join(publicada, 'src'), 0o755);
            fs.chmodSync(path.join(publicada, 'src', 'server.js'), 0o644);
            fs.writeFileSync(path.join(publicada, 'src', 'server.js'), '// código alterado depois de verificado');
          }
        };
        return A;
      },
    });
    const e = await falha(instalarBackend(amb, 1, deps));
    assert.equal(e.codigo, 'INTEGRIDADE_DIVERGENTE');
    assert.match(e.message, /não confere com o manifesto/);
    assert.equal(existeLink(amb.link('backend')), false);
    assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => /^hml-/.test(n)), [], 'a release adulterada não ficou publicada');
    assert.deepEqual(dadosPersistentes(amb), antes);
  });

  test('conferirArvorePreparo, isolada: aceita a árvore intacta e recusa link, extra e ausente', () => {
    const { conferirArvorePreparo } = require(NUCLEO);
    const A = criarAncoraPorCaminho({});
    const raiz = tmp();
    const base = A.abrirBase(raiz);
    const preparo = A.abrirFilho(base, 'p', { criar: true });
    const sub = A.abrirFilho(preparo, 'src', { criar: true });
    const id = A.copiarArquivo(path.join(criarRelease({ n: 1 }), 'portal', 'index.html'), sub, 'a.html');
    const arquivos = new Map([['src/a.html', id]]);
    const diretorios = new Map([['', preparo], ['src', sub]]);
    assert.doesNotThrow(() => conferirArvorePreparo({ A, preparo, arquivos, diretorios }));
    fs.writeFileSync(path.join(raiz, 'p', 'src', 'extra'), 'x');
    assert.throws(() => conferirArvorePreparo({ A, preparo, arquivos, diretorios }), (e) => /inesperado/.test(e.message));
    fs.rmSync(path.join(raiz, 'p', 'src', 'extra'));
    fs.symlinkSync('/etc', path.join(raiz, 'p', 'ln'));
    assert.throws(() => conferirArvorePreparo({ A, preparo, arquivos, diretorios }), (e) => /link inesperado/.test(e.message));
    A.fecharTudo();
  });
});

// ===================================================================================== F6

describe('F6 — o destino efetivo do ponteiro é a release verificada', () => {
  test('árvore de releases trocada depois da abertura das âncoras: o ponteiro é recusado e desfeito, e o conteúdo alheio nunca fica ativo', async () => {
    const amb = criarAmbiente();
    const m = criarFsModelo();
    const antes = dadosPersistentes(amb);
    const { deps } = criarDeps(amb, {
      criarAncora: (op) => {
        const A = criarAncora({ ...op, modo: 'proc', fsImpl: m.fs });
        const renomear = A.renomear;
        let trocou = false;
        A.renomear = (deDir, de, paraDir, para) => {
          renomear(deDir, de, paraDir, para);
          if (!trocou && de.startsWith('.preparo-')) {
            trocou = true;
            const rr = path.join(amb.www, '.releases');
            m.mover(rr, `${rr}.saved`);
            fs.mkdirSync(path.join(rr, 'app', R(1)), { recursive: true });
            fs.writeFileSync(path.join(rr, 'app', R(1), 'index.html'), 'conteúdo não aprovado');
          }
        };
        return A;
      },
    });
    const e = await falha(instalarPortal(amb, 1, deps));
    assert.equal(e.codigo, 'FALHA_POS_TROCA');
    assert.equal(e.detalhes.causa, 'PONTEIRO_DIVERGENTE');
    assert.equal(e.detalhes.desfeito, true);
    assert.equal(existeLink(amb.link('portal')), false, 'o link foi desfeito');
    assert.deepEqual(dadosPersistentes(amb), antes);
  });

  test('confirmarDestinoDoLink: aceita o destino certo e recusa um link que alcança outro diretório', () => {
    const { confirmarDestinoDoLink, abrirContexto } = require(NUCLEO);
    const amb = criarAmbiente();
    const A = criarAncoraPorCaminho({});
    const ctx = abrirContexto(A, { ...amb.config.componentes.portal }, { criar: true });
    fs.mkdirSync(path.join(amb.releases('portal'), R(1)));
    fs.symlinkSync(path.posix.join('.releases', 'app', R(1)), amb.link('portal'));
    assert.doesNotThrow(() => confirmarDestinoDoLink(ctx, R(1)));
    fs.mkdirSync(path.join(amb.releases('portal'), R(2)));
    assert.throws(() => confirmarDestinoDoLink(ctx, R(2)), (e) => e.codigo === 'PONTEIRO_DIVERGENTE');
    A.fecharTudo();
  });
});

// ===================================================================================== F7

describe('F7 — diário ilegível bloqueia integridade, reconciliação, instalação e reversão', () => {
  function falharLeituraDoDiario() {
    const original = fs.openSync;
    let falhas = 0;
    fs.openSync = function aberturaComFalha(p, flags, ...resto) {
      if (path.basename(String(p)) === 'diario.jsonl' && (flags === undefined || flags === fs.constants.O_RDONLY || (typeof flags === 'number' && (flags & 3) === 0))) { falhas += 1; throw Object.assign(new Error('EIO de leitura sintético'), { code: 'EIO' }); }
      return original.call(this, p, flags, ...resto);
    };
    return { restaurar: () => { fs.openSync = original; }, get falhas() { return falhas; } };
  }

  test('identificar com o diário ilegível nunca devolve íntegro, e informa a leitura que falhou', async () => {
    const amb = criarAmbiente();
    const { sim, deps } = simulador(amb, { executar: executarDoPreparo });
    await instalarDir(amb, 'backend', criarBackend({ n: 1 }), deps);
    assert.equal((await identificar(amb, 'backend')).integro, true);
    const f = falharLeituraDoDiario();
    let id;
    try { id = await identificar(amb, 'backend'); } finally { f.restaurar(); }
    assert.ok(f.falhas > 0);
    assert.equal(id.integro, false);
    assert.equal(id.consistente, false);
    assert.ok(id.problemas.some((p) => /diário ilegível/.test(p)), id.problemas.join('; '));
    assert.equal(id.diarioLinhasIlegiveis, null);
    await exigirNaoDivergir(amb, sim);
  });

  test('diário que é link simbólico também reprova a integridade', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const diario = path.join(amb.releases('portal'), 'diario.jsonl');
    fs.renameSync(diario, `${diario}.orig`);
    fs.symlinkSync(`${diario}.orig`, diario);
    const id = await identificar(amb, 'portal');
    assert.equal(id.integro, false);
    assert.ok(id.problemas.some((p) => /diário ilegível/.test(p)));
  });

  test('reconciliar, instalar e reverter com o diário ilegível são recusados (DIARIO_ILEGIVEL) sem reiniciar nem remover nada', async () => {
    const amb = criarAmbiente();
    const { sim, deps } = simulador(amb, { executar: executarDoPreparo });
    await instalarDir(amb, 'backend', criarBackend({ n: 1 }), deps);
    await instalarDir(amb, 'backend', criarBackend({ n: 2 }), deps);
    const orfa = path.join(amb.releases('backend'), '.preparo-esquecido');
    fs.mkdirSync(orfa);
    const reiniciosAntes = sim.reinicios;
    const f = falharLeituraDoDiario();
    try {
      const e1 = await falha(inst().reconciliar({ config: amb.config, componente: 'backend', deps }));
      const e2 = await falha(instalarDir(amb, 'backend', criarBackend({ n: 3 }), deps));
      const e3 = await falha(reverterBackend(amb, deps));
      assert.deepEqual([e1.codigo, e2.codigo, e3.codigo], ['DIARIO_ILEGIVEL', 'DIARIO_ILEGIVEL', 'DIARIO_ILEGIVEL']);
    } finally { f.restaurar(); }
    assert.equal(sim.reinicios, reiniciosAntes, 'nada foi reiniciado');
    assert.equal(fs.existsSync(orfa), true, 'nenhuma limpeza foi feita sobre um registro ilegível');
    assert.equal(rotuloDoLink(amb, 'backend'), R(2));
  });

  test('falha encadeada (estado, diário e leitura do diário) nunca termina em integridade aprovada', async () => {
    const amb = criarAmbiente();
    const { sim, deps } = simulador(amb, { executar: executarDoPreparo });
    await instalarDir(amb, 'backend', criarBackend({ n: 1 }), deps);
    await instalarDir(amb, 'backend', criarBackend({ n: 2 }), deps);
    const reiniciar = deps.reiniciar;
    let reinicios = 0;
    deps.reiniciar = async () => { reinicios += 1; if (reinicios === 2) throw new Error('reinício da recuperação falhou'); await reiniciar(); };
    const renomear = fs.renameSync;
    fs.renameSync = function renameComFalha(a, b) { if (reinicios >= 1 && String(b).endsWith('/estado.json')) throw Object.assign(new Error('EIO estado'), { code: 'EIO' }); return renomear.apply(this, arguments); };
    let e;
    try { e = await falha(reverterBackend(amb, deps)); } finally { fs.renameSync = renomear; }
    assert.ok(e.codigo);
    const f = falharLeituraDoDiario();
    let id;
    try { id = await identificar(amb, 'backend'); } finally { f.restaurar(); }
    assert.equal(id.integro, false);
    assert.equal(id.consistente, false);
    void sim;
  });
});

// ===================================================================================== F8

describe('F8 — o aviso de durabilidade acompanha toda operação que escreve', () => {
  function semFsyncDeDiretorio() {
    const original = fs.fsyncSync;
    fs.fsyncSync = function fsyncSemSuporte(fd) {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EINVAL sintético'), { code: 'EINVAL' });
      return original.call(this, fd);
    };
    return () => { fs.fsyncSync = original; };
  }

  test('reverter devolve DURABILIDADE_NAO_GARANTIDA quando o fsync de diretório não é suportado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    await instalarPortal(amb, 1, deps);
    await instalarPortal(amb, 2, deps);
    const restaurar = semFsyncDeDiretorio();
    let r;
    try { r = await inst().reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps }); } finally { restaurar(); }
    assert.equal(r.resultado, 'REVERTIDA');
    assert.ok(r.avisos.some((a) => a.codigo === 'DURABILIDADE_NAO_GARANTIDA'), JSON.stringify(r.avisos));
  });

  test('reconciliar devolve o aviso quando precisa sincronizar diretórios, e reverter com exigência de durabilidade é recusado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    await instalarPortal(amb, 1, deps);
    await instalarPortal(amb, 2, deps);
    fs.mkdirSync(path.join(amb.releases('portal'), '.preparo-esquecido'));
    const restaurar = semFsyncDeDiretorio();
    try {
      const r = await inst().reconciliar({ config: amb.config, componente: 'portal', deps });
      assert.deepEqual(r.orfasRemovidas, ['.preparo-esquecido']);
      assert.ok(r.avisos.some((a) => a.codigo === 'DURABILIDADE_NAO_GARANTIDA'));
      const e = await falha(inst().reverter({ config: amb.config, componente: 'portal', opcoes: { exigirDurabilidade: true }, deps }));
      assert.equal(e.codigo, 'DURABILIDADE_NAO_SUPORTADA');
    } finally { restaurar(); }
  });
});

// ===================================================================================== F9

describe('F9 — a evidência da coordenação pertence à operação que a leu', () => {
  test('duas instalações concorrentes que compartilham o provedor citam, cada uma, o hash do que ela leu', async () => {
    const dirCoord = tmp();
    const arquivo = path.join(dirCoord, 'coordenacao.json');
    const consulta = inst().criarConsultaPorArquivo(arquivo);
    let n = 0;
    const lidos = new Map();
    const consultar = async () => {
      n += 1;
      const dados = { situacao: 'LIVRE', origem: `sintetica-${n}`, consultadoEm: new Date(AGORA0).toISOString() };
      fs.writeFileSync(arquivo, JSON.stringify(dados), { mode: 0o600 });
      lidos.set(dados.origem, sha256(fs.readFileSync(arquivo)));
      return consulta();
    };
    const a = criarAmbiente();
    const b = criarAmbiente();
    const da = criarDeps(a, { consultarCoordenacao: consultar }).deps;
    const db = criarDeps(b, { consultarCoordenacao: consultar }).deps;
    await Promise.all([instalarBackend(a, 1, da), instalarBackend(b, 1, db)]);
    for (const amb of [a, b]) {
      const evento = estadoDe(amb, 'backend').historico.at(-1);
      assert.equal(evento.coordenacao.fonte.sha256, lidos.get(evento.coordenacao.origem), 'a evidência é a da leitura que gerou o estado citado');
    }
  });

  test('a função de consulta não guarda estado de evidência', () => {
    const consultar = inst().criarConsultaPorArquivo(path.join(tmp(), 'x.json'));
    assert.deepEqual(Object.keys(consultar), []);
  });
});

// ===================================================================================== F10

describe('F10 — o bloqueio do backend não se contorna pela biblioteca nem por dependências injetadas', () => {
  test('instalar e reverter o backend com provedor injetado não homologado: recusados antes de qualquer reinício', async () => {
    const amb = criarAmbiente();
    const marcador = path.join(amb.raiz, 'reinicio-executado');
    const consultar = async () => ({ situacao: 'LIVRE', origem: 'nao-homologado', consultadoEm: new Date(AGORA0).toISOString() });
    const deps = { ...criarDeps(amb).deps, consultarCoordenacao: consultar, reiniciar: async () => { fs.writeFileSync(marcador, 'x'); } };
    const dir = criarBackend({ n: 1 });
    const e1 = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps }));
    const e2 = await falha(inst().reverter({ config: amb.config, componente: 'backend', opcoes: { observado: observadoDe('000_a.sql') }, deps }));
    assert.deepEqual([e1.codigo, e2.codigo], ['COORDENACAO_NAO_HOMOLOGADA', 'COORDENACAO_NAO_HOMOLOGADA']);
    assert.equal(fs.existsSync(marcador), false);
    assert.equal(fs.existsSync(path.join(amb.app, '.releases')), false, 'nada foi criado');
  });

  test('sem provedor, e com o provedor padrão, o backend também é recusado; identificar e reconciliar continuam permitidos', async () => {
    const amb = criarAmbiente();
    const base = criarDeps(amb).deps;
    delete base.consultarCoordenacao;
    const dir = criarBackend({ n: 1 });
    const e = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps: base }));
    assert.equal(e.codigo, 'COORDENACAO_NAO_HOMOLOGADA');
    assert.equal((await identificar(amb, 'backend')).instalado, false);
    assert.equal((await inst().reconciliar({ config: amb.config, componente: 'backend', deps: { criarAncora: criarAncoraPorCaminho } })).interrompida, false);
  });

  test('um provedor homologado (só em teste) passa, e o registro só existe em NODE_ENV=test', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    assert.equal((await instalarBackend(amb, 1, deps)).resultado, 'INSTALADA');
    const { homologarProvedorParaTeste, provedorHomologado } = require(COORD);
    const anterior = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      assert.throws(() => homologarProvedorParaTeste(async () => ({})), /só existe em testes/);
    } finally { process.env.NODE_ENV = anterior; }
    assert.equal(provedorHomologado(async () => ({})), false);
    assert.equal(provedorHomologado(undefined), false);
  });

  test('fora de NODE_ENV=test a âncora por caminho, o fsImpl e a âncora injetada são recusados', async () => {
    const amb = criarAmbiente();
    const anterior = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      assert.throws(() => criarAncora({ modo: 'caminho', semGarantiaDeCorrida: true }), (e) => e.codigo === 'ANCORA_DE_TESTE_FORA_DE_TESTE');
      assert.throws(() => criarAncora({ modo: 'proc', fsImpl: criarFsModelo().fs }), (e) => e.codigo === 'ANCORA_DE_TESTE_FORA_DE_TESTE');
      const e = await falha(instalarPortal(amb, 1, { criarAncora: criarAncoraPorCaminho }));
      assert.equal(e.codigo, 'ANCORA_DE_TESTE_FORA_DE_TESTE');
      assert.equal(fs.existsSync(path.join(amb.www, '.releases')), false);
    } finally { process.env.NODE_ENV = anterior; }
  });

  test('uma âncora já criada e injetada por fábrica fora de NODE_ENV=test é recusada pela própria biblioteca', async () => {
    const amb = criarAmbiente();
    const pronta = criarAncoraPorCaminho({});
    const anterior = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const e = await falha(instalarPortal(amb, 1, { criarAncora: () => pronta }));
      assert.equal(e.codigo, 'ANCORA_DE_TESTE_FORA_DE_TESTE');
      assert.equal(fs.existsSync(path.join(amb.www, '.releases')), false);
    } finally { process.env.NODE_ENV = anterior; pronta.fecharTudo(); }
  });

  test('a âncora de leitura (usada por identificar fora do Linux) recusa toda escrita, troca e remoção', () => {
    const A = criarAncora({ modo: 'leitura' });
    const raiz = tmp();
    fs.writeFileSync(path.join(raiz, 'a'), 'x');
    const base = A.abrirBase(raiz);
    assert.equal(A.garantiaContraCorrida, false);
    assert.equal(A.lerTexto(base, 'a'), 'x');
    for (const [nome, chamar] of [
      ['escreverAtomico', () => A.escreverAtomico(base, 'b', 'y')], ['anexar', () => A.anexar(base, 'd', 'y')],
      ['trocarLink', () => A.trocarLink(base, 'l', 'a')], ['criarLink', () => A.criarLink(base, 'l', 'a')],
      ['removerEntrada', () => A.removerEntrada(base, 'a')], ['removerArvore', () => A.removerArvore(base, 'a')],
      ['renomear', () => A.renomear(base, 'a', base, 'c')], ['criarExclusivo', () => A.criarExclusivo(base, 'n')],
      ['abrirFilho criar', () => A.abrirFilho(base, 'n', { criar: true })], ['copiarArquivo', () => A.copiarArquivo(path.join(raiz, 'a'), base, 'cp')],
      ['chmod', () => A.comArquivo(base, 'a', (f) => f.chmod(0o600))],
    ]) assert.throws(chamar, (e) => e.codigo === 'ANCORA_SOMENTE_LEITURA', nome);
    assert.deepEqual(fs.readdirSync(raiz), ['a']);
    A.fecharTudo();
  });
});

// ===================================================================================== só Linux

describe('Linux real: o que a emulação local não prova', () => {
  test('troca real de ancestral, de .releases e de subdiretório do preparo durante um processo externo (/proc/self/fd)', { skip: SO_LINUX }, async () => {
    const amb = criarAmbiente();
    const antes = dadosPersistentes(amb);
    const { deps } = criarDeps(amb, {
      criarAncora: undefined,
      executar: async (cmd, args, o) => { redirecionar(path.join(o.caminho, 'src'), amb.data); },
    });
    delete deps.criarAncora;
    await falha(instalarBackend(amb, 1, deps));
    assert.deepEqual(dadosPersistentes(amb), antes);
  });
});
