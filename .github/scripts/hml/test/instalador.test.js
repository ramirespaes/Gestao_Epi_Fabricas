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
 * Instalador de releases versionados (deploy/hml/instalador). Tudo em diretórios
 * temporários: nada toca AWS, serviços, banco ou os caminhos reais de homologação.
 * Prova: integridade SHA-256, troca atômica por link simbólico, trava de
 * concorrência, preservação de diretórios persistentes, rollback seguro e
 * bloqueio por incompatibilidade de migrations/contratos.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MODULO = path.join(REPO, 'deploy', 'hml', 'instalador', 'instalar-release.js');
const AGORA0 = Date.parse('2026-11-04T12:00:00.000Z');
const temporarios = [];
// Testes e desenvolvimento: âncora por caminho, sem garantia contra substituição concorrente (reconhecida de forma explícita).
const criarAncoraPorCaminho = (op) => require(path.join(REPO, 'deploy', 'hml', 'instalador', 'ancora.js')).criarAncora({ ...op, modo: 'caminho', semGarantiaDeCorrida: true });

const R = (n) => `hml-20261104T1${n}0000-${String(n).repeat(7)}`;
const COMMIT = (n) => String(n).repeat(40);
const sha256 = (c) => crypto.createHash('sha256').update(c).digest('hex');

// Estes testes exercitam o instalador com a autenticidade já satisfeita: cada release chega com o hash
// aprovado do próprio release.json, como faria o canal externo. A recusa sem hash tem testes próprios
// em correcoes-instalador.test.js.
function comAutenticidade(modulo) {
  return {
    ...modulo,
    instalar: (args) => {
      const opcoes = args.opcoes || {};
      if (opcoes.releaseSha256Esperado !== undefined || opcoes.semAutenticacao === true) return modulo.instalar(args);
      let hash;
      try { hash = sha256(fs.readFileSync(path.join(args.release, 'release.json'))); } catch { hash = undefined; }
      return modulo.instalar({ ...args, opcoes: { ...opcoes, releaseSha256Esperado: hash } });
    },
  };
}
function carregar() {
  try {
    return comAutenticidade(require(MODULO));
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes('instalar-release')) assert.fail('deploy/hml/instalador/instalar-release.js ainda não existe (RED esperado)');
    throw erro;
  }
}
function tmp() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-inst-'));
  temporarios.push(dir);
  return dir;
}
function listar(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? listar(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  }).sort();
}
function hashDaArvore(dir) {
  const itens = [];
  const andar = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const relFilho = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) itens.push(`${relFilho}->${fs.readlinkSync(path.join(abs, e.name))}`);
      else if (e.isDirectory()) andar(path.join(abs, e.name), relFilho);
      else itens.push(`${relFilho}:${sha256(fs.readFileSync(path.join(abs, e.name)))}`);
    }
  };
  andar(dir, '');
  return sha256(itens.sort().join('\n'));
}
function codigoDe(promessa) {
  return promessa.then(() => assert.fail('esperava recusa'), (erro) => erro);
}
const existeLink = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Release no layout de gerar-release.js / empacotar-backend.js.
function criarRelease({ componente = 'portal', n = 1, arquivos, atual = true, secao = {}, rotulo, commit } = {}) {
  const dir = tmp();
  const conteudos = arquivos || { 'index.html': `<p>v${n}</p>`, 'js/app.js': `// v${n}\n`, 'css/a.css': 'a{}' };
  const manifesto = {};
  for (const [rel, c] of Object.entries(conteudos)) {
    fs.mkdirSync(path.dirname(path.join(dir, componente, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, componente, rel), c);
    manifesto[rel] = sha256(c);
  }
  const texto = `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, `manifesto-${componente}.sha256`), texto);
  const rot = rotulo || (atual ? R(n) : `${R(n)}-retroativo`);
  const release = { commit: commit || COMMIT(n), rotulo: rot, atual, geradoEm: '2026-11-04T10:00:00.000Z', [componente]: { arquivos: Object.keys(manifesto).length, manifestoSha256: sha256(texto), ...secao } };
  fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return dir;
}
// Backend coerente: cada migration declarada existe no pacote, com o checksums.json e o engines do package.json.
function criarReleaseBackend({ n = 1, migrations = ['000_a.sql'], contratos = {}, atual = true } = {}) {
  const lock = '{"lockfileVersion":3}';
  const sqls = Object.fromEntries(migrations.map((nome) => [`migrations/${nome}`, `-- ${nome}\n`]));
  const hashes = Object.fromEntries(Object.entries(sqls).map(([rel, c]) => [path.posix.basename(rel), sha256(c)]));
  return criarRelease({
    componente: 'backend', n, atual,
    arquivos: { 'package.json': '{"engines":{"node":">=22"}}', 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, ...sqls, 'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: hashes }) },
    secao: { lockfileSha256: sha256(lock), node: '>=22', migrations: migrations.map((nome) => ({ nome, sha256: sha256(`-- ${nome}\n`) })), contratos },
  });
}
let ambienteAtual = null;

function criarAmbiente(mod = {}) {
  const raiz = tmp();
  const www = path.join(raiz, 'www'); const app = path.join(raiz, 'app');
  const data = path.join(raiz, 'data'); const secrets = path.join(raiz, 'secrets');
  for (const d of [www, app, path.join(data, 'imagens'), secrets]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(secrets, 'backend.env'), 'SEGREDO=nao-mexer\n');
  fs.writeFileSync(path.join(data, 'imagens', 'a.png'), 'png');
  const config = {
    raizesPersistentes: [data, secrets],
    retencao: 3,
    componentes: {
      portal: { tipo: 'estatico', base: www, nome: 'app' },
      painel: { tipo: 'estatico', base: www, nome: 'admin' },
      backend: {
        tipo: 'backend', base: app, nome: 'backend',
        linksPersistentes: [{ nome: '.env', destino: path.join(secrets, 'backend.env') }, { nome: 'armazenamento', destino: path.join(data, 'imagens') }],
        dependencias: { comando: ['/usr/bin/npm', 'ci', '--omit=dev', '--ignore-scripts'] },
      },
    },
    ...mod,
  };
  const releases = (c) => path.join(config.componentes[c].base, '.releases', config.componentes[c].nome);
  const link = (c) => path.join(config.componentes[c].base, config.componentes[c].nome);
  const ambiente = { raiz, www, app, data, secrets, config, releases, link };
  ambienteAtual = ambiente;
  return ambiente;
}

function criarDeps(sobrescrever = {}) {
  let tick = 0; let pid = 100;
  const chamadas = { executar: [], reiniciar: 0, saude: 0 };
  const deps = {
    criarAncora: criarAncoraPorCaminho,
    agora: () => AGORA0 + (tick++) * 1000,
    esperar: async () => {},
    executar: async (cmd, args, opc) => {
      chamadas.executar.push({ cmd, args, cwd: opc.cwd });
      fs.mkdirSync(path.join(opc.cwd, 'node_modules', 'zod'), { recursive: true });
      fs.writeFileSync(path.join(opc.cwd, 'node_modules', 'zod', 'index.js'), '1');
    },
    reiniciar: async () => { chamadas.reiniciar += 1; },
    verificarSaude: async () => { chamadas.saude += 1; return { ok: true, detalhe: 'ok' }; },
    identificarProcesso: async () => { pid += 1; return { pid, cwd: fs.realpathSync(ambienteAtual.link('backend')) }; },
    consultarCoordenacao: async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date(AGORA0).toISOString() }),
    ...sobrescrever,
  };
  if (deps.consultarCoordenacao) require(path.join(REPO, 'deploy', 'hml', 'instalador', 'coordenacao.js')).homologarProvedorParaTeste(deps.consultarCoordenacao);
  return { deps, chamadas };
}
const observadoDe = (...migrations) => ({ banco: 'hml', origem: 'sonda-teste', coletadoEm: new Date(AGORA0).toISOString(), migrations, contratos: {} });
const lerJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

afterEach(() => {
  while (temporarios.length) {
    const d = temporarios.pop();
    try { fs.chmodSync(d, 0o755); } catch { /* ignora */ }
    const liberar = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const a = path.join(p, e.name); if (e.isDirectory()) { fs.chmodSync(a, 0o755); liberar(a); } } };
    try { liberar(d); } catch { /* ignora */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('instalador — instalação de frontend estático', () => {
  test('primeira instalação: link relativo, release imutável, versao.json, meta e estado', async () => {
    const { instalar, identificar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    const r = await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps });
    assert.equal(r.resultado, 'INSTALADA');
    assert.equal(r.rotulo, R(1));
    assert.equal(fs.lstatSync(amb.link('portal')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(amb.link('portal')), `.releases/app/${R(1)}`);
    assert.equal(fs.readFileSync(path.join(amb.link('portal'), 'index.html'), 'utf8'), '<p>v1</p>');
    const versao = lerJson(path.join(amb.releases('portal'), 'versao.json'));
    assert.equal(versao.rotulo, R(1)); assert.equal(versao.commit, COMMIT(1)); assert.equal(versao.componente, 'portal'); assert.equal(versao.atual, undefined, 'versao.json público não expõe mais que o necessário');
    assert.match(versao.manifestoSha256, /^[0-9a-f]{64}$/);
    const meta = lerJson(path.join(amb.releases('portal'), 'meta', `${R(1)}.json`));
    assert.equal(Object.keys(meta.manifesto).length, 3);
    const estado = lerJson(path.join(amb.releases('portal'), 'estado.json'));
    assert.equal(estado.atual.rotulo, R(1)); assert.equal(estado.anterior, null);
    assert.equal(fs.statSync(path.join(amb.link('portal'), 'index.html')).mode & 0o222, 0, 'arquivos da release são somente leitura');
    const id = await identificar({ config: amb.config, componente: 'portal' });
    assert.deepEqual([id.instalado, id.rotulo, id.commit, id.integro, id.anterior], [true, R(1), COMMIT(1), true, null]);
    assert.deepEqual(fs.readdirSync(amb.releases('portal')).filter((n) => n.startsWith('.preparo') || n.includes('.novo-')), []);
    assert.deepEqual(fs.readdirSync(amb.www).filter((n) => n.includes('.novo-')), []);
  });

  test('segunda instalação troca o link, guarda a anterior e mantém a release antiga intacta', async () => {
    const { instalar, identificar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps });
    const r2 = await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 2 }), opcoes: {}, deps });
    assert.equal(r2.anterior, R(1));
    assert.equal(fs.readlinkSync(amb.link('portal')), `.releases/app/${R(2)}`);
    assert.equal(fs.readlinkSync(path.join(amb.releases('portal'), 'anterior')), R(1));
    assert.equal(fs.readFileSync(path.join(amb.releases('portal'), R(1), 'index.html'), 'utf8'), '<p>v1</p>');
    assert.equal(lerJson(path.join(amb.releases('portal'), 'versao.json')).rotulo, R(2));
    const id = await identificar({ config: amb.config, componente: 'portal' });
    assert.deepEqual([id.rotulo, id.anterior, id.integro], [R(2), R(1), true]);
  });

  test('portal e painel coexistem na mesma base sem interferência', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ componente: 'portal', n: 1 }), opcoes: {}, deps });
    await instalar({ config: amb.config, componente: 'painel', release: criarRelease({ componente: 'painel', n: 2 }), opcoes: {}, deps });
    assert.equal(fs.readFileSync(path.join(amb.link('portal'), 'index.html'), 'utf8'), '<p>v1</p>');
    assert.equal(fs.readFileSync(path.join(amb.link('painel'), 'index.html'), 'utf8'), '<p>v2</p>');
    assert.equal(lerJson(path.join(amb.releases('painel'), 'versao.json')).componente, 'painel');
  });

  test('reinstalar a mesma release é idempotente e não altera nada', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    const dir = criarRelease({ n: 1 });
    await instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: {}, deps });
    const antes = hashDaArvore(amb.releases('portal'));
    const r = await instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: {}, deps });
    assert.equal(r.resultado, 'JA_INSTALADA');
    assert.equal(hashDaArvore(amb.releases('portal')), antes);
  });

  test('release adulterada, incompleta ou com intruso é recusada antes de qualquer escrita', async () => {
    const { instalar } = carregar();
    const casos = {
      arquivoAlterado: (d) => fs.appendFileSync(path.join(d, 'portal', 'js', 'app.js'), '//x'),
      arquivoRemovido: (d) => fs.rmSync(path.join(d, 'portal', 'css', 'a.css')),
      intruso: (d) => fs.writeFileSync(path.join(d, 'portal', 'intruso.js'), 'x'),
      linkNaRelease: (d) => fs.symlinkSync('/etc/hosts', path.join(d, 'portal', 'hosts')),
      manifestoAdulterado: (d) => { const f = path.join(d, 'manifesto-portal.sha256'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^./, (c) => (c === '0' ? '1' : '0'))); },
    };
    for (const [nome, adulterar] of Object.entries(casos)) {
      const amb = criarAmbiente();
      const dir = criarRelease({ n: 1 });
      adulterar(dir);
      const erro = await codigoDe(instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: {}, deps: criarDeps().deps }));
      assert.equal(erro.codigo, 'INTEGRIDADE_DIVERGENTE', nome);
      assert.equal(existeLink(amb.link('portal')), false, nome);
      assert.equal(fs.existsSync(amb.releases('portal')), false, `${nome}: nada criado`);
    }
  });

  test('release.json inválido é recusado: commit, rótulo, coerência atual/retroativo, seção ausente', async () => {
    const { instalar } = carregar();
    const alterar = (mod) => { const d = criarRelease({ n: 1 }); const f = path.join(d, 'release.json'); const j = lerJson(f); mod(j); fs.writeFileSync(f, JSON.stringify(j)); return d; };
    const dirs = [
      alterar((j) => { j.commit = 'abc'; }),
      alterar((j) => { j.rotulo = 'hml-qualquer'; }),
      alterar((j) => { j.rotulo = '../../etc/passwd'; }),
      alterar((j) => { j.atual = false; }),
      alterar((j) => { delete j.portal; }),
      alterar((j) => { j.portal.manifestoSha256 = 'xyz'; }),
      alterar((j) => { j.portal.arquivos = 99; }),
    ];
    for (const dir of dirs) {
      const amb = criarAmbiente();
      const erro = await codigoDe(instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: {}, deps: criarDeps().deps }));
      assert.ok(['RELEASE_INVALIDA', 'INTEGRIDADE_DIVERGENTE'].includes(erro.codigo), erro.codigo);
      assert.equal(fs.existsSync(amb.releases('portal')), false);
    }
    const amb = criarAmbiente();
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'inexistente', release: criarRelease({ n: 1 }), opcoes: {}, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'COMPONENTE_DESCONHECIDO');
  });

  test('diretório real no lugar do link é recusado e seu conteúdo preservado (adoção é passo manual)', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    fs.mkdirSync(amb.link('portal'));
    fs.writeFileSync(path.join(amb.link('portal'), 'legado.html'), 'legado');
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'ATUAL_NAO_E_LINK');
    assert.equal(fs.readFileSync(path.join(amb.link('portal'), 'legado.html'), 'utf8'), 'legado');
  });

  test('retenção remove só releases antigas, preserva atual e anterior e ignora pastas que não são release', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    for (const n of [1, 2]) await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n }), opcoes: {}, deps });
    fs.mkdirSync(path.join(amb.releases('portal'), 'nao-e-release'));
    fs.writeFileSync(path.join(amb.releases('portal'), 'nao-e-release', 'x'), 'x');
    for (const n of [3, 4, 5]) await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n }), opcoes: {}, deps });
    const presentes = fs.readdirSync(amb.releases('portal')).filter((nome) => /^hml-/.test(nome)).sort();
    assert.deepEqual(presentes, [R(3), R(4), R(5)]);
    assert.deepEqual(fs.readdirSync(path.join(amb.releases('portal'), 'meta')).sort(), [`${R(3)}.json`, `${R(4)}.json`, `${R(5)}.json`]);
    assert.equal(fs.existsSync(path.join(amb.releases('portal'), 'nao-e-release', 'x')), true);
    assert.equal(fs.readlinkSync(path.join(amb.releases('portal'), 'anterior')), R(4));
  });

  test('identificar detecta adulteração posterior de arquivo publicado, remoção e arquivo extra', async () => {
    const { instalar, identificar } = carregar();
    const amb = criarAmbiente();
    await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps: criarDeps().deps });
    const alvo = path.join(amb.releases('portal'), R(1), 'js', 'app.js');
    fs.chmodSync(alvo, 0o644); fs.appendFileSync(alvo, '//x');
    let id = await identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.integro, false);
    assert.ok(id.problemas.some((p) => p.includes('js/app.js')));
    fs.writeFileSync(alvo, '// v1\n');
    assert.equal((await identificar({ config: amb.config, componente: 'portal' })).integro, true);
    fs.chmodSync(path.join(amb.releases('portal'), R(1)), 0o755);
    fs.writeFileSync(path.join(amb.releases('portal'), R(1), 'extra.html'), 'x');
    id = await identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.integro, false);
    const vazio = await identificar({ config: criarAmbiente().config, componente: 'painel' });
    assert.equal(vazio.instalado, false);
  });
});

describe('instalador — controle de concorrência', () => {
  test('trava já existente recusa a instalação sem alterar nada, e a trava de outro processo não é removida', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    fs.mkdirSync(path.join(amb.releases('portal'), '.trava'), { recursive: true });
    fs.writeFileSync(path.join(amb.releases('portal'), '.trava', 'info.json'), JSON.stringify({ pid: 99999, iniciadoEm: '2026-11-04T09:00:00.000Z' }));
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'TRAVA_OCUPADA');
    assert.match(erro.message, /99999/);
    assert.equal(existeLink(amb.link('portal')), false);
    assert.equal(fs.existsSync(path.join(amb.releases('portal'), '.trava', 'info.json')), true);
  });

  test('duas instalações simultâneas: a segunda é recusada enquanto a primeira roda; a trava é liberada ao fim e após falha', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    // Frontend estático não tem ganchos de saúde nem de reinício (política): a concorrência é provada com o backend.
    const trava = path.join(amb.releases('backend'), '.trava');
    const obs = { observado: observadoDe('000_a.sql') };
    let liberar;
    const segura = new Promise((resolve) => { liberar = resolve; });
    const primeira = instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: obs, deps: criarDeps({ verificarSaude: async () => { await segura; return { ok: true }; } }).deps });
    for (let i = 0; i < 50 && !fs.existsSync(trava); i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(fs.existsSync(trava), true);
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 2 }), opcoes: obs, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'TRAVA_OCUPADA');
    liberar();
    await primeira;
    assert.equal(fs.existsSync(trava), false);
    assert.equal(fs.readlinkSync(amb.link('backend')), `.releases/backend/${R(1)}`);

    const falha = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 2 }), opcoes: { ...obs, tentativasSaude: 1 }, deps: criarDeps({ verificarSaude: async () => ({ ok: false }) }).deps }));
    assert.equal(falha.codigo, 'SAUDE_FALHOU');
    assert.equal(fs.existsSync(trava), false, 'trava liberada mesmo na falha');
  });
});

describe('instalador — configuração e diretórios persistentes', () => {
  test('configuração insegura é recusada: caminhos relativos, sobreposição com persistentes, links e comandos fora da regra', () => {
    const { validarConfig } = carregar();
    const base = () => criarAmbiente().config;
    const ruim = (mod) => { const c = base(); mod(c); return () => validarConfig(c); };
    const invalida = (fn) => assert.throws(fn, (e) => e.codigo === 'CONFIG_INVALIDA');
    assert.doesNotThrow(() => validarConfig(base()));
    invalida(ruim((c) => { c.componentes.portal.base = 'relativo/www'; }));
    invalida(ruim((c) => { c.componentes.portal.nome = 'a/b'; }));
    invalida(ruim((c) => { c.componentes.portal.nome = '.releases'; }));
    invalida(ruim((c) => { c.componentes.portal.tipo = 'outro'; }));
    invalida(ruim((c) => { c.raizesPersistentes = [c.componentes.backend.base]; }));
    invalida(ruim((c) => { c.raizesPersistentes = [path.join(c.componentes.backend.base, 'backend')]; }));
    invalida(ruim((c) => { c.raizesPersistentes = [path.join(c.componentes.backend.base, '.releases', 'backend', 'dados')]; }));
    invalida(ruim((c) => { c.raizesPersistentes = [path.dirname(c.componentes.portal.base)]; }));
    invalida(ruim((c) => { c.raizesPersistentes = ['relativo']; }));
    invalida(ruim((c) => { c.componentes.backend.linksPersistentes[0].nome = '../x'; }));
    invalida(ruim((c) => { c.componentes.backend.linksPersistentes[0].nome = 'a/b'; }));
    invalida(ruim((c) => { c.componentes.backend.linksPersistentes[0].destino = '/etc/passwd'; }));
    invalida(ruim((c) => { c.componentes.backend.linksPersistentes[0].destino = 'relativo'; }));
    invalida(ruim((c) => { c.componentes.backend.linksPersistentes.push({ nome: '.env', destino: c.componentes.backend.linksPersistentes[0].destino }); }));
    invalida(ruim((c) => { c.componentes.backend.dependencias.comando = ['npm', 'install']; }));
    invalida(ruim((c) => { c.componentes.backend.dependencias.comando = ['sh', '-c', 'npm ci']; }));
    invalida(ruim((c) => { c.componentes.backend.dependencias.comando = ['npm', 'ci', '--omit=dev']; }));
    invalida(ruim((c) => { c.retencao = 1; }));
    invalida(ruim((c) => { c.retencao = 21; }));
    invalida(ruim((c) => { c.componentes.painel.nome = 'app'; }));
    invalida(ruim((c) => { c.componentes.backend.saude = { url: 'https://externo.exemplo.test/health' }; }));
    invalida(ruim((c) => { c.componentes.backend.reinicio = { comando: 'systemctl restart x' }; }));
    invalida(ruim((c) => { c.componentes.backend.reinicio = { comando: ['systemctl', 'restart', 'x'] }; }));
    assert.doesNotThrow(ruim((c) => { c.componentes.backend.saude = { url: 'http://127.0.0.1:3000/api/health', tentativas: 3, intervaloMs: 1000, timeoutMs: 2000 }; c.componentes.backend.reinicio = { comando: ['/usr/bin/systemctl', 'restart', 'safework-hml.service'] }; }));
  });

  test('backend: links persistentes apontam para os dados reais, que nunca são escritos, copiados nem apagados (nem pela retenção)', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    const antes = { data: hashDaArvore(amb.data), secrets: hashDaArvore(amb.secrets), nomes: [listar(amb.data), listar(amb.secrets)] };
    for (const n of [1, 2, 3, 4, 5]) await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n }), opcoes: { observado: observadoDe('000_a.sql') }, deps });
    const atual = path.join(amb.releases('backend'), R(5));
    assert.equal(fs.readlinkSync(path.join(atual, '.env')), path.join(amb.secrets, 'backend.env'));
    assert.equal(fs.readlinkSync(path.join(atual, 'armazenamento')), path.join(amb.data, 'imagens'));
    assert.equal(fs.readFileSync(path.join(amb.link('backend'), '.env'), 'utf8'), 'SEGREDO=nao-mexer\n');
    assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => /^hml-/.test(n)).sort(), [R(3), R(4), R(5)], 'R1 e R2 (com links para dados) foram removidas');
    assert.equal(hashDaArvore(amb.data), antes.data);
    assert.equal(hashDaArvore(amb.secrets), antes.secrets);
    assert.deepEqual([listar(amb.data), listar(amb.secrets)], antes.nomes);
  });

  test('backend: destino persistente ausente ou link que colide com arquivo da release recusa a instalação sem deixar rastro', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    fs.rmSync(path.join(amb.secrets, 'backend.env'));
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { observado: observadoDe('000_a.sql') }, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'PERSISTENTE_AUSENTE');
    assert.equal(existeLink(amb.link('backend')), false);
    assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => n.startsWith('.preparo')), []);

    const amb2 = criarAmbiente();
    amb2.config.componentes.backend.linksPersistentes[0].nome = 'package.json';
    const erro2 = await codigoDe(instalar({ config: amb2.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { observado: observadoDe('000_a.sql') }, deps: criarDeps().deps }));
    assert.equal(erro2.codigo, 'LINK_CONFLITA');
    assert.equal(existeLink(amb2.link('backend')), false);
  });

  test('backend: dependências por npm ci fixo, uma vez, no diretório de preparo; node_modules fica fora do manifesto sem quebrar a verificação', async () => {
    const { instalar, identificar } = carregar();
    const amb = criarAmbiente();
    const { deps, chamadas } = criarDeps();
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { observado: observadoDe('000_a.sql') }, deps });
    assert.equal(chamadas.executar.length, 1);
    assert.deepEqual([chamadas.executar[0].cmd, chamadas.executar[0].args], ['/usr/bin/npm', ['ci', '--omit=dev', '--ignore-scripts']]);
    assert.ok(chamadas.executar[0].cwd.startsWith(path.join(amb.releases('backend'), '.preparo-')));
    assert.equal(fs.existsSync(path.join(amb.releases('backend'), R(1), 'node_modules', 'zod', 'index.js')), true);
    assert.equal((await identificar({ config: amb.config, componente: 'backend' })).integro, true);
  });

  test('backend: falha ao instalar dependências aborta sem trocar nada e remove o preparo', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { observado: observadoDe('000_a.sql') }, deps });
    const falho = criarDeps({ executar: async () => { throw new Error('rede fora'); } }).deps;
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 2 }), opcoes: { observado: observadoDe('000_a.sql') }, deps: falho }));
    assert.equal(erro.codigo, 'DEPENDENCIAS_FALHARAM');
    assert.equal(fs.readlinkSync(amb.link('backend')), `.releases/backend/${R(1)}`);
    assert.deepEqual(fs.readdirSync(amb.releases('backend')).filter((n) => n.startsWith('.preparo') || n === R(2)), []);
  });

  test('backend exige reinício e verificação de saúde configurados: sem eles nada é alterado', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    for (const [faltando, codigo] of [['verificarSaude', 'SAUDE_NAO_CONFIGURADA'], ['reiniciar', 'REINICIO_NAO_CONFIGURADO']]) {
      const { deps } = criarDeps();
      delete deps[faltando];
      const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { observado: observadoDe('000_a.sql') }, deps }));
      assert.equal(erro.codigo, codigo);
      assert.equal(existeLink(amb.link('backend')), false);
      assert.equal(fs.existsSync(amb.releases('backend')), false);
    }
  });
});

describe('instalador — política de versão', () => {
  test('release mais antiga que a atual (downgrade) exige permitirAnterior; retroativa exige permitirRetroativo', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 5 }), opcoes: {}, deps });
    const antiga = criarRelease({ n: 2 });
    let erro = await codigoDe(instalar({ config: amb.config, componente: 'portal', release: antiga, opcoes: {}, deps }));
    assert.equal(erro.codigo, 'DOWNGRADE_BLOQUEADO');
    assert.equal(fs.readlinkSync(amb.link('portal')), `.releases/app/${R(5)}`);
    const retro = criarRelease({ n: 2, atual: false });
    erro = await codigoDe(instalar({ config: amb.config, componente: 'portal', release: retro, opcoes: { permitirAnterior: true }, deps }));
    assert.equal(erro.codigo, 'RETROATIVA_BLOQUEADA');
    const r = await instalar({ config: amb.config, componente: 'portal', release: retro, opcoes: { permitirAnterior: true, permitirRetroativo: true }, deps });
    assert.equal(r.resultado, 'INSTALADA');
    assert.equal(r.rotulo, `${R(2)}-retroativo`);
    assert.equal(lerJson(path.join(amb.releases('portal'), 'meta', `${R(2)}-retroativo.json`)).atual, false);
  });
});

describe('instalador — saúde, rollback automático e reversão manual', () => {
  test('saúde falha após a troca: volta sozinho para a anterior, reinicia de novo e registra a reversão', async () => {
    const { instalar, identificar } = carregar();
    const amb = criarAmbiente();
    const obs = { observado: observadoDe('000_a.sql') };
    const saudeConforme = (servindo) => async () => ({ ok: path.basename(fs.readlinkSync(amb.link('backend'))) === servindo });
    const ok = criarDeps({ verificarSaude: saudeConforme(R(1)) });
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: obs, deps: ok.deps });
    const ruim = criarDeps({ verificarSaude: saudeConforme(R(1)) });
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 2 }), opcoes: { ...obs, tentativasSaude: 2 }, deps: ruim.deps }));
    assert.equal(erro.codigo, 'SAUDE_FALHOU');
    assert.deepEqual([erro.detalhes.reverteu, erro.detalhes.saudeAposReversao], [true, true]);
    assert.equal(ruim.chamadas.reiniciar, 2);
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(1));
    const estado = lerJson(path.join(amb.releases('backend'), 'estado.json'));
    assert.equal(estado.atual.rotulo, R(1));
    assert.equal(estado.historico.at(-1).evento, 'REVERSAO_AUTOMATICA');
    assert.equal(estado.historico.at(-1).rotulo, R(2));
    assert.equal(fs.existsSync(path.join(amb.releases('backend'), R(2))), true, 'release com defeito fica para diagnóstico');
    assert.equal((await identificar({ config: amb.config, componente: 'backend' })).rotulo, R(1));
  });

  test('saúde falha na primeira instalação: nenhum link fica apontando para a release com defeito', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { tentativasSaude: 2, observado: observadoDe('000_a.sql') }, deps: criarDeps({ verificarSaude: async () => ({ ok: false }) }).deps }));
    assert.equal(erro.codigo, 'SAUDE_FALHOU');
    assert.equal(erro.detalhes.reverteu, false);
    assert.equal(existeLink(amb.link('backend')), false);
    assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).atual, null);
  });

  test('a saúde é tentada o número configurado de vezes antes de desistir, e uma recuperação no meio vale', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    let n = 0;
    const r = await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { tentativasSaude: 3, observado: observadoDe('000_a.sql') }, deps: criarDeps({ verificarSaude: async () => { n += 1; return { ok: n >= 3 }; } }).deps });
    assert.equal(r.resultado, 'INSTALADA');
    assert.equal(n, 3);
  });

  test('reverter troca atual e anterior, valida a integridade do destino e pode ser repetido', async () => {
    const { instalar, reverter, identificar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    for (const n of [1, 2]) await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n }), opcoes: {}, deps });
    let r = await reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps });
    assert.deepEqual([r.resultado, r.rotulo, r.anterior], ['REVERTIDA', R(1), R(2)]);
    assert.equal(fs.readFileSync(path.join(amb.link('portal'), 'index.html'), 'utf8'), '<p>v1</p>');
    r = await reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps });
    assert.deepEqual([r.rotulo, r.anterior], [R(2), R(1)]);
    assert.equal((await identificar({ config: amb.config, componente: 'portal' })).rotulo, R(2));
    assert.equal(lerJson(path.join(amb.releases('portal'), 'estado.json')).historico.at(-1).evento, 'REVERSAO_MANUAL');
  });

  test('reverter sem anterior ou com anterior corrompida é recusado sem alterar o link', async () => {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps });
    let erro = await codigoDe(reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps }));
    assert.equal(erro.codigo, 'SEM_ANTERIOR');
    await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 2 }), opcoes: {}, deps });
    const alvo = path.join(amb.releases('portal'), R(1), 'js', 'app.js');
    fs.chmodSync(alvo, 0o644); fs.appendFileSync(alvo, '//x');
    erro = await codigoDe(reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps }));
    assert.equal(erro.codigo, 'ANTERIOR_CORROMPIDA');
    assert.equal(fs.readlinkSync(amb.link('portal')), `.releases/app/${R(2)}`);
  });

  test('saúde falha após a reversão manual: não volta sozinho (evita vaivém) e informa', async () => {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    const obs = { observado: observadoDe('000_a.sql') };
    for (const n of [1, 2]) await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n }), opcoes: obs, deps });
    const erro = await codigoDe(reverter({ config: amb.config, componente: 'backend', opcoes: { ...obs, tentativasSaude: 1 }, deps: criarDeps({ verificarSaude: async () => ({ ok: false }) }).deps }));
    assert.equal(erro.codigo, 'SAUDE_FALHOU_APOS_REVERSAO');
    assert.equal(fs.readlinkSync(amb.link('backend')), `.releases/backend/${R(1)}`);
  });
});

describe('instalador — compatibilidade de migrations e contratos no backend', () => {
  test('sem estado observado a instalação do backend é recusada', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: {}, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'INCOMPATIVEL');
    assert.deepEqual(erro.detalhes.bloqueios.map((b) => b.codigo), ['OBSERVADO_AUSENTE']);
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('o estado observado pode vir da dependência lerObservado', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps({ lerObservado: async () => observadoDe('000_a.sql') });
    assert.equal((await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: {}, deps })).resultado, 'INSTALADA');
  });

  test('migration pendente na release bloqueia a troca (gate de migrations é separado)', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1, migrations: ['000_a.sql', '001_b.sql'] }), opcoes: { observado: observadoDe('000_a.sql') }, deps: criarDeps().deps }));
    assert.equal(erro.codigo, 'INCOMPATIVEL');
    assert.deepEqual(erro.detalhes.bloqueios.map((b) => b.codigo), ['MIGRATIONS_PENDENTES']);
  });

  test('rollback para versão sem migration já aplicada é bloqueado e o estado não muda', async () => {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1, migrations: ['000_a.sql'] }), opcoes: { observado: observadoDe('000_a.sql') }, deps });
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 2, migrations: ['000_a.sql', '001_b.sql'] }), opcoes: { observado: observadoDe('000_a.sql', '001_b.sql') }, deps });
    const antes = hashDaArvore(amb.releases('backend'));
    const erro = await codigoDe(reverter({ config: amb.config, componente: 'backend', opcoes: { observado: observadoDe('000_a.sql', '001_b.sql') }, deps }));
    assert.equal(erro.codigo, 'INCOMPATIVEL');
    assert.deepEqual(erro.detalhes.bloqueios.map((b) => b.codigo), ['BANCO_A_FRENTE_DO_CODIGO']);
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(2));
    assert.equal(hashDaArvore(amb.releases('backend')), antes);
  });

  test('rollback entre releases com o mesmo conjunto de migrations é liberado', async () => {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const { deps, chamadas } = criarDeps();
    for (const n of [1, 2]) await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n }), opcoes: { observado: observadoDe('000_a.sql') }, deps });
    const r = await reverter({ config: amb.config, componente: 'backend', opcoes: { observado: observadoDe('000_a.sql') }, deps });
    assert.equal(r.rotulo, R(1));
    assert.equal(chamadas.reiniciar, 3);
  });

  test('contrato persistente em versão maior que a da release bloqueia a reversão', async () => {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1, contratos: { 'manifesto-backup': 1 } }), opcoes: { observado: { ...observadoDe('000_a.sql'), contratos: { 'manifesto-backup': 1 } } }, deps });
    await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 2, contratos: { 'manifesto-backup': 2 } }), opcoes: { observado: { ...observadoDe('000_a.sql'), contratos: { 'manifesto-backup': 1 } } }, deps });
    const erro = await codigoDe(reverter({ config: amb.config, componente: 'backend', opcoes: { observado: { ...observadoDe('000_a.sql'), contratos: { 'manifesto-backup': 2 } } }, deps }));
    assert.deepEqual(erro.detalhes.bloqueios.map((b) => b.codigo), ['CONTRATO_A_FRENTE']);
  });

  test('frontend não consulta migrations nem contratos', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    assert.equal((await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps: criarDeps().deps })).resultado, 'INSTALADA');
  });
});

describe('instalador — coordenação com D-ORF-6 (interface; nenhuma trava homologada)', () => {
  test('sem provedor de coordenação, o backend não troca nem com atestado humano (Codex B05); o frontend troca', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    delete deps.consultarCoordenacao;
    const obs = { observado: observadoDe('000_a.sql') };
    const erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: obs, deps }));
    assert.equal(erro.codigo, 'COORDENACAO_NAO_HOMOLOGADA');
    assert.equal(existeLink(amb.link('backend')), false);
    assert.equal((await instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps })).resultado, 'INSTALADA');
    // O atestado humano não impede um backup concorrente: não libera mais a troca do backend.
    const comAtestado = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { ...obs, atestarSemOperacao: true }, deps }));
    assert.equal(comAtestado.codigo, 'COORDENACAO_NAO_HOMOLOGADA');
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('operação em curso bloqueia mesmo com atestado, e LIVRE antigo não vale', async () => {
    const { instalar } = carregar();
    const amb = criarAmbiente();
    const obs = { observado: observadoDe('000_a.sql') };
    const ocupado = criarDeps({ consultarCoordenacao: async () => ({ situacao: 'OCUPADO', origem: 'teste', detalhe: 'backup em curso', consultadoEm: new Date(AGORA0).toISOString() }) }).deps;
    let erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { ...obs, atestarSemOperacao: true }, deps: ocupado }));
    assert.equal(erro.codigo, 'OPERACAO_EM_CURSO');
    const velho = criarDeps({ consultarCoordenacao: async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: '2026-11-04T10:00:00.000Z' }) }).deps;
    erro = await codigoDe(instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: obs, deps: velho }));
    assert.equal(erro.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('a reversão do backend também passa pela coordenação', async () => {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    const obs = { observado: observadoDe('000_a.sql') };
    for (const n of [1, 2]) await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n }), opcoes: obs, deps });
    const ocupado = criarDeps({ consultarCoordenacao: async () => ({ situacao: 'OCUPADO', origem: 'teste', consultadoEm: new Date(AGORA0).toISOString() }) }).deps;
    const erro = await codigoDe(reverter({ config: amb.config, componente: 'backend', opcoes: obs, deps: ocupado }));
    assert.equal(erro.codigo, 'OPERACAO_EM_CURSO');
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(2));
  });
});

describe('instalador — integração com as releases reais e linha de comando', () => {
  test('releases reais do Portal, Painel e backend são instaladas e identificadas com integridade', async () => {
    const { instalar, identificar } = carregar();
    const { gerarRelease } = require(path.join(REPO, '.github', 'scripts', 'hml', 'gerar-release.js'));
    const { gerarReleaseBackend } = require(path.join(REPO, 'deploy', 'hml', 'empacotar-backend.js'));
    const commit = COMMIT(7);
    const base = tmp();
    gerarRelease({ saida: path.join(base, 'frontend'), commit, rotulo: R(7), atual: true });
    const back = gerarReleaseBackend({ saida: path.join(base, 'backend'), commit, rotulo: R(7), atual: true });
    const amb = criarAmbiente();
    const { deps } = criarDeps();
    await instalar({ config: amb.config, componente: 'portal', release: path.join(base, 'frontend'), opcoes: {}, deps });
    await instalar({ config: amb.config, componente: 'painel', release: path.join(base, 'frontend'), opcoes: {}, deps });
    await instalar({ config: amb.config, componente: 'backend', release: path.join(base, 'backend'), opcoes: { observado: observadoDe(...back.release.backend.migrations.map((m) => m.nome)) }, deps });
    assert.equal(fs.readFileSync(path.join(amb.link('portal'), 'portal', 'index.html'), 'utf8'), fs.readFileSync(path.join(REPO, 'frontend', 'portal', 'index.html'), 'utf8'));
    assert.equal(fs.existsSync(path.join(amb.link('painel'), 'painel-privado', 'index.html')), true);
    assert.equal(fs.existsSync(path.join(amb.link('portal'), 'painel-privado')), false);
    assert.equal(fs.existsSync(path.join(amb.link('backend'), 'src', 'server.js')), true);
    for (const c of ['portal', 'painel', 'backend']) {
      const id = await identificar({ config: amb.config, componente: c });
      assert.deepEqual([id.instalado, id.integro, id.commit], [true, true, commit], c);
    }
  });

  test('o módulo usa só o núcleo do Node e módulos irmãos (copiável sozinho para o servidor)', () => {
    carregar();
    const dir = path.dirname(MODULO);
    for (const arquivo of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const fonte = fs.readFileSync(path.join(dir, arquivo), 'utf8');
      for (const m of fonte.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        assert.ok(m[1].startsWith('node:') || m[1].startsWith('./'), `${arquivo} requer ${m[1]}`);
      }
      assert.doesNotMatch(fonte, /\bsudo\b|child_process'\)\.exec\(|shell:\s*true/, `${arquivo}: sem shell nem sudo`);
    }
  });

  test('linha de comando: instalar, identificar, repetir (idempotente) e recusar com código 1', async () => {
    carregar();
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config), { mode: 0o600 });
    const rodar = (...args) => spawnSync(process.execPath, [MODULO, ...args], { encoding: 'utf8' });
    const dir = criarRelease({ n: 1 });
    const hash = sha256(fs.readFileSync(path.join(dir, 'release.json')));
    const ok = rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', hash);
    if (process.platform === 'linux') {
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(JSON.parse(ok.stdout).resultado, 'INSTALADA');
      const id = rodar('identificar', '--config', cfg, '--componente', 'portal');
      assert.equal(id.status, 0, id.stderr);
      assert.deepEqual([JSON.parse(id.stdout).rotulo, JSON.parse(id.stdout).integro], [R(1), true]);
      assert.equal(JSON.parse(rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', hash).stdout).resultado, 'JA_INSTALADA');
    } else {
      // Sem a âncora real por descritor (/proc/self/fd) a instalação pela linha de comando é bloqueada, nunca degradada.
      assert.equal(ok.status, 1);
      assert.match(ok.stderr, /PLATAFORMA_SEM_ANCORA/);
    }
    const recusa = rodar('instalar', '--config', cfg, '--componente', 'inexistente', '--release', dir, '--release-sha256', hash);
    assert.equal(recusa.status, 1);
    assert.match(recusa.stderr, /COMPONENTE_DESCONHECIDO/);
    assert.equal(rodar('instalar', '--config', cfg).status, 1);
    assert.equal(rodar('apagar', '--config', cfg, '--componente', 'portal').status, 1);
    assert.equal(rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--flag-desconhecida').status, 1);
    const dirBackend = criarReleaseBackend({ n: 1 });
    const backend = rodar('instalar', '--config', cfg, '--componente', 'backend', '--release', dirBackend, '--release-sha256', sha256(fs.readFileSync(path.join(dirBackend, 'release.json'))));
    assert.equal(backend.status, 1, 'backend sem saude e reinicio na configuração');
  });
});
