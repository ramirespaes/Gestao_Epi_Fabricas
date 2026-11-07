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

// ===================================================================================== arquitetura

describe('T01/T03 — âncoras por descritor: toda mutação passa pelo descritor do diretório, nunca por caminho remontado', () => {
  test('modo proc (emulado): instalações, retenção, reversão, rollback e identificação completos, sem nenhuma mutação por caminho remontado', async () => {
    const emu = criarFsEmulado();
    const amb = criarAmbiente();
    const { sim, deps } = simulador(amb, { criarAncora: fabricaEmulada(emu), executar: executarDoPreparo });
    for (const n of [1, 2, 3, 4]) assert.equal((await instalarDir(amb, 'backend', criarBackend({ n }), deps)).resultado, 'INSTALADA');
    assert.equal((await reverterBackend(amb, deps)).resultado, 'REVERTIDA');
    const original = deps.reiniciar;
    let k = 0;
    deps.reiniciar = async () => { k += 1; await original(); if (k === 1) throw new Error('falha do reinício da nova'); };
    const e = await falha(instalarDir(amb, 'backend', criarBackend({ n: 5 }), deps));
    assert.equal(e.codigo, 'REINICIO_FALHOU');
    assert.equal(e.detalhes.recuperado, true);
    const id = await identificar(amb, 'backend');
    assert.equal(id.integro, true, id.problemas.join('; '));
    await exigirNaoDivergir(amb, sim);
    assert.ok(emu.mutacoes.length > 100, `mutações observadas: ${emu.mutacoes.length}`);
    assert.deepEqual(emu.mutacoes.filter((m) => !m.caminho.startsWith('/proc/')), [], 'nenhuma mutação usou um caminho remontado');
    const restantes = fs.readdirSync(amb.releases('backend')).filter((n) => /^hml-/.test(n));
    assert.ok(!restantes.includes(R(1)), `a retenção removeu a release mais antiga pelo descritor: ${restantes}`);
  });

  test('modo proc (emulado): a entrada do preparo trocada antes do rename final nunca é publicada (T01)', async () => {
    const emu = criarFsEmulado();
    const amb = criarAmbiente();
    const fora = path.join(amb.data, 'espelho');
    fs.mkdirSync(path.join(fora, 'js'), { recursive: true });
    fs.writeFileSync(path.join(fora, 'index.html'), '<p>v1</p>');
    fs.writeFileSync(path.join(fora, 'js', 'app.js'), '// v1\n');
    const antes = arvore(amb.data);
    const { deps } = criarDeps(amb, { criarAncora: fabricaEmulada(emu) });
    await comArmadilha('renameSync', (p) => p.includes('.preparo-') || p.startsWith('/proc/'), () => {
      const preparo = fs.readdirSync(amb.releases('portal')).find((n) => n.startsWith('.preparo-'));
      if (!preparo) return;
      const abs = path.join(amb.releases('portal'), preparo);
      fs.renameSync(abs, `${abs}.original`);
      fs.symlinkSync(fora, abs);
    }, async () => {
      const e = await falha(instalarPortal(amb, 1, deps));
      assert.ok(['RELEASE_SUBSTITUIDA', 'CAMINHO_OPERACIONAL_INVALIDO'].includes(e.codigo), e.codigo);
    });
    assert.equal(existeLink(amb.link('portal')), false);
    assert.deepEqual(arvore(amb.data), antes);
  });

  test('a âncora por caminho nunca é escolhida sozinha: a padrão exige /proc e a por caminho exige reconhecimento (sem garantia de corrida)', () => {
    assert.throws(() => criarAncora({ modo: 'caminho' }), (e) => e.codigo === 'ANCORA_SEM_GARANTIA_NAO_RECONHECIDA');
    const emu = criarFsEmulado();
    const A = criarAncora({ modo: 'proc', fsImpl: emu.fs });
    assert.equal(A.garantiaContraCorrida, true);
    assert.equal(criarAncoraPorCaminho({}).garantiaContraCorrida, false);
    const base = A.abrirBase(tmp());
    assert.match(A.cwdParaProcessoExterno(base), new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
    A.fecharTudo();
  });

  test('resultado e identificação informam o modo da âncora; sem /proc a identificação declara que não tem garantia de corrida', async () => {
    const amb = criarAmbiente();
    const r = await instalarPortal(amb, 1, criarDeps(amb).deps);
    assert.equal(r.ancora, 'caminho');
    const id = await identificar(amb, 'portal');
    assert.equal(id.garantiaContraCorrida, LINUX);
  });
});

describe('T04 — a exigência de durabilidade é de cada operação, nunca global', () => {
  test('duas instalações concorrentes no mesmo processo: a que exige durabilidade continua exigindo depois que a outra conclui', async () => {
    const amb = criarAmbiente();
    let liberar;
    const segura = new Promise((resolve) => { liberar = resolve; });
    let emA = null;
    const { deps: depsA } = criarDeps(amb, { executar: async () => { emA(); await segura; } });
    const dirA = criarBackend({ n: 1 });
    const promessaA = inst().instalar({ config: amb.config, componente: 'backend', release: dirA, opcoes: opc(dirA, { exigirDurabilidade: true }), deps: depsA });
    const iniciou = new Promise((resolve) => { emA = resolve; });
    await iniciou;
    // A partir daqui qualquer fsync de diretório falha com EINVAL (sistema de arquivos sem suporte).
    const o = { fsync: fs.fsyncSync };
    fs.fsyncSync = function (fd) { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EINVAL sintético'), { code: 'EINVAL' }); return o.fsync.call(this, fd); };
    let resultadoB; let erroA;
    try {
      resultadoB = await instalarPortal(amb, 1, criarDeps(amb).deps);
      liberar();
      erroA = await falha(promessaA);
    } finally { fs.fsyncSync = o.fsync; liberar(); }
    assert.equal(resultadoB.resultado, 'INSTALADA');
    assert.ok(resultadoB.avisos.some((a) => a.codigo === 'DURABILIDADE_NAO_GARANTIDA'), 'B tolera e informa');
    assert.equal(erroA.codigo, 'DURABILIDADE_NAO_SUPORTADA', 'A não foi enfraquecida pela conclusão de B');
    assert.equal(existeLink(amb.link('backend')), false, 'A não publicou nada');
  });

  test('não existe nenhum estado mutável de segurança ou durabilidade no nível do módulo', () => {
    for (const arq of ['instalador/instalar-release.js', 'instalador/nucleo.js', 'instalador/ancora.js']) {
      const codigo = fs.readFileSync(path.join(REPO, 'deploy', 'hml', arq), 'utf8');
      assert.doesNotMatch(codigo, /^(?:let|var)\s/m, `${arq}: variável mutável de módulo`);
      assert.doesNotMatch(codigo, /definirExigenciaDeDurabilidade/, arq);
    }
    const nucleo = require(NUCLEO);
    assert.equal(nucleo.durabilidade, undefined);
    assert.equal(nucleo.definirExigenciaDeDurabilidade, undefined);
  });
});

describe('T05 — política explícita de operações por componente, aplicada às interfaces expostas', () => {
  const N = () => require(NUCLEO);

  test('a tabela de política: backend na linha de comando só identifica e reconcilia; estático faz tudo', () => {
    const { verificarOperacaoNaInterface } = N();
    for (const op of ['instalar', 'reverter']) assert.throws(() => verificarOperacaoNaInterface('backend', op, 'cli'), (e) => e.codigo === 'COORDENACAO_NAO_HOMOLOGADA', op);
    for (const op of ['identificar', 'reconciliar']) assert.doesNotThrow(() => verificarOperacaoNaInterface('backend', op, 'cli'), op);
    for (const op of ['instalar', 'reverter', 'identificar', 'reconciliar']) assert.doesNotThrow(() => verificarOperacaoNaInterface('estatico', op, 'cli'), op);
    assert.throws(() => verificarOperacaoNaInterface('inventado', 'instalar', 'cli'), (e) => e.codigo === 'COMPONENTE_DESCONHECIDO');
    assert.throws(() => { N().POLITICA_DE_COMPONENTES.estatico.cli.push('x'); }, TypeError, 'a tabela é congelada');
  });

  test('reinício, processo, saúde, dependências e links persistentes são recusados na configuração de um componente estático (sonda do Codex)', () => {
    const { validarConfig } = inst();
    const amb = criarAmbiente();
    const campos = {
      reinicio: { comando: [process.execPath, '-e', '0'] }, processo: { pidComando: [process.execPath, '-e', '0'] },
      saude: { url: 'http://127.0.0.1:3000/api/health' }, dependencias: { comando: [NPM, 'ci', '--omit=dev', '--ignore-scripts'] },
      linksPersistentes: [{ nome: '.env', destino: path.join(amb.secrets, 'backend.env') }],
    };
    for (const [campo, valor] of Object.entries(campos)) {
      const config = { ...amb.config, componentes: { portal: { ...amb.config.componentes.portal, [campo]: valor } } };
      assert.throws(() => validarConfig(config), (e) => e.codigo === 'CONFIG_INVALIDA' && /só vale para componente backend/.test(e.message), campo);
    }
    assert.doesNotThrow(() => validarConfig(amb.config));
  });

  test('linha de comando: um reinício configurado em componente estático nunca é executado (sonda do Codex)', () => {
    const amb = criarAmbiente();
    const marcador = path.join(tmp(), 'reinicio-executado');
    const config = { ...amb.config, componentes: { portal: { ...amb.config.componentes.portal, reinicio: { comando: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marcador)}, 'x')`] } } } };
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(config), { mode: 0o600 });
    const dir = criarRelease({ n: 1 });
    const r = spawnSync(process.execPath, [MODULO, 'instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', aprovado(dir)], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CONFIG_INVALIDA/);
    assert.equal(fs.existsSync(marcador), false, 'o comando de reinício não foi executado');
  });

  test('biblioteca: um componente estático nunca reinicia nada, mesmo que o chamador entregue um reinício', async () => {
    const amb = criarAmbiente();
    const { deps, chamadas } = criarDeps(amb);
    assert.equal((await instalarPortal(amb, 1, deps)).resultado, 'INSTALADA');
    assert.equal((await instalarPortal(amb, 2, deps)).resultado, 'INSTALADA');
    assert.equal((await inst().reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps })).resultado, 'REVERTIDA');
    assert.deepEqual([chamadas.reiniciar, chamadas.saude, chamadas.processo], [0, 0, 0]);
    assert.ok(!diarioDe(amb, 'portal').some((p) => p.passo === 'REINICIANDO'));
  });

  test('linha de comando: o backend segue bloqueado para instalar e reverter; identificar e reconciliar passam pela política', () => {
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config), { mode: 0o600 });
    const rodar = (...a) => spawnSync(process.execPath, [MODULO, ...a], { encoding: 'utf8' });
    const dir = criarBackend({ n: 1 });
    for (const a of [['instalar', '--release', dir, '--release-sha256', aprovado(dir)], ['reverter']]) {
      const r = rodar(a[0], '--config', cfg, '--componente', 'backend', ...a.slice(1));
      assert.equal(r.status, 1, a[0]);
      assert.match(r.stderr, /COORDENACAO_NAO_HOMOLOGADA/, a[0]);
    }
    for (const op of ['identificar', 'reconciliar']) {
      const r = rodar(op, '--config', cfg, '--componente', 'backend');
      assert.doesNotMatch(r.stderr, /COORDENACAO_NAO_HOMOLOGADA/, op);
    }
  });
});

// ===================================================================================== só Linux

describe('B01/T02 — resolução real pelo kernel (/proc/self/fd): exige Linux, executa no CI', () => {
  const depsReais = (amb, extra = {}) => criarDeps(amb, { criarAncora: undefined, ...extra }).deps;

  test('a âncora real usa /proc/self/fd e o processo externo recebe o inode verificado como cwd', { skip: SO_LINUX }, () => {
    const A = criarAncora({});
    assert.equal(A.modo, 'proc');
    const base = A.abrirBase(tmp());
    const cwd = A.cwdParaProcessoExterno(base);
    assert.match(cwd, new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd, encoding: 'utf8' });
    assert.equal(r.stdout, base.caminho);
    A.fecharTudo();
  });

  test('o processo externo escreve no inode verificado mesmo que o nome do preparo seja trocado por um link para o persistente (T02)', { skip: SO_LINUX }, async () => {
    const amb = criarAmbiente();
    const fora = path.join(amb.data, 'espelho');
    fs.mkdirSync(fora, { recursive: true });
    const antes = arvore(amb.data);
    let original = null;
    const deps = depsReais(amb, {
      executar: async (cmd, args, o) => {
        original = o.caminho;
        redirecionar(o.caminho, fora);
        const r = spawnSync(process.execPath, ['-e', "require('fs').writeFileSync('external-child-write', 'x')"], { cwd: o.cwd });
        assert.equal(r.status, 0);
      },
    });
    const dir = criarBackend({ n: 1 });
    await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps }));
    assert.deepEqual(arvore(amb.data), antes, 'o persistente não recebeu a escrita do processo externo');
    assert.equal(fs.existsSync(path.join(`${original}.orig`, 'external-child-write')), true, 'a escrita ficou no diretório verificado');
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('meta/ trocado por link durante a espera: as gravações seguem no diretório original e o persistente fica intacto', { skip: SO_LINUX }, async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    const meta = path.join(amb.releases('backend'), 'meta');
    const deps = depsReais(amb, { executar: async () => { redirecionar(meta, amb.data); } });
    await instalarBackend(amb, 1, deps).catch(() => null);
    assert.deepEqual(arvore(amb.data), antes);
    assert.ok(fs.readdirSync(`${meta}.orig`).some((n) => n.includes(R(1))), 'o metadado ficou no diretório original');
  });

  test('.releases/<nome> e .releases trocados por link durante a espera: o persistente fica intacto', { skip: SO_LINUX }, async () => {
    for (const alvo of [(amb) => amb.releases('backend'), (amb) => path.join(amb.app, '.releases')]) {
      const amb = criarAmbiente();
      const antes = arvore(amb.data);
      const deps = depsReais(amb, { executar: async () => { redirecionar(alvo(amb), amb.data); } });
      await instalarBackend(amb, 1, deps).catch(() => null);
      assert.deepEqual(arvore(amb.data), antes);
    }
  });

  test('E/S assíncrona pendente continua no diretório de origem durante uma instalação real', { skip: SO_LINUX }, async () => {
    const amb = criarAmbiente();
    const origem = tmp();
    const escrita = fs.promises.writeFile(path.join(origem, 'pendente.txt'), 'ok');
    await instalarPortal(amb, 1, depsReais(amb));
    await escrita;
    assert.equal(fs.readFileSync(path.join(origem, 'pendente.txt'), 'utf8'), 'ok');
  });

  test('instalação, retenção, reversão e rollback completos com a âncora real', { skip: SO_LINUX }, async () => {
    const amb = criarAmbiente();
    const { sim, deps } = simulador(amb, { criarAncora: undefined, executar: executarDoPreparo });
    for (const n of [1, 2, 3, 4]) assert.equal((await instalarDir(amb, 'backend', criarBackend({ n }), deps)).resultado, 'INSTALADA');
    assert.equal((await reverterBackend(amb, deps)).resultado, 'REVERTIDA');
    const id = await identificar(amb, 'backend');
    assert.equal(id.garantiaContraCorrida, true);
    assert.equal(id.integro, true, id.problemas.join('; '));
    await exigirNaoDivergir(amb, sim);
  });
});

// ===================================================================================== sobreviventes da mutação

describe('T01 — identidade verificada em cada ponto de publicação e de remoção', () => {
  test('a entrada do preparo trocada por OUTRO diretório real antes do rename nunca é apontada (identidade, não só o tipo)', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    let trocada = false;
    await comArmadilha('renameSync', (p) => p.includes('.preparo-'), (p) => {
      trocada = true;
      fs.renameSync(p, `${p}.original`);
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, 'index.html'), '<p>outro diretório real</p>');
    }, async () => {
      const e = await falha(instalarPortal(amb, 1, deps));
      assert.equal(e.codigo, 'RELEASE_SUBSTITUIDA');
    });
    assert.equal(trocada, true);
    assert.equal(existeLink(amb.link('portal')), false, 'nada foi apontado para a release substituída');
  });

  test('um link atual que não aponta para .releases/<componente>/<rótulo> é recusado como inconsistente', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const alvo = path.join(amb.data, `${R(1)}`);
    fs.mkdirSync(alvo, { recursive: true });
    fs.rmSync(amb.link('portal'));
    fs.symlinkSync(alvo, amb.link('portal'));
    const antes = arvore(amb.data);
    const e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.equal(e.codigo, 'ATUAL_INCONSISTENTE');
    assert.deepEqual(arvore(amb.data), antes);
  });

  test('removerArvore com identidade recusa remover uma entrada que foi substituída depois de ser identificada', () => {
    const A = criarAncoraPorCaminho({});
    const pai = tmp();
    const base = A.abrirBase(pai);
    fs.mkdirSync(path.join(pai, 'alvo'));
    const filho = A.abrirFilho(base, 'alvo', { confiavel: false });
    const identidade = A.identidade(filho);
    A.fechar(filho);
    fs.renameSync(path.join(pai, 'alvo'), path.join(pai, 'alvo.original'));
    fs.mkdirSync(path.join(pai, 'alvo'));
    fs.writeFileSync(path.join(pai, 'alvo', 'dado'), 'do outro escritor');
    assert.throws(() => A.removerArvore(base, 'alvo', { identidade }), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.equal(fs.readFileSync(path.join(pai, 'alvo', 'dado'), 'utf8'), 'do outro escritor', 'a entrada nova não foi apagada');
    A.fecharTudo();
  });
});
