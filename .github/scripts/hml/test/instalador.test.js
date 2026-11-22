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
// Para os testes que usam a hora real (o provedor real do guardião carimba as consultas com ela).
const observadoAgora = (...migrations) => ({ ...observadoDe(...migrations), coletadoEm: new Date().toISOString() });
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

// 3B-2B-3B: fluxo de PRODUÇÃO do backend no instalador, sem homologarProvedorParaTeste. Só três condições juntas
// liberam: configuração oficial do agente habilitada (C1), guardião real reconhecido para a baseline que o próprio
// instalador lê (baseline, commit, roteiro e hash) e uma autorização desta operação, consumida uma única vez (C2).
// O único mecanismo de teste é a origem da configuração oficial passada em deps.configuracaoOficial, aceita só com
// NODE_ENV=test: todas as conferências do leitor continuam valendo sobre esse arquivo, com o dono esperado sendo o
// usuário do teste (ou o informado).
describe('3B-2B-3B: backend pelo provedor do guardião (fluxo de produção do instalador)', () => {
  const PROVEDOR = path.join(REPO, 'deploy', 'hml', 'cd', 'coordenacao-por-guardiao.js');
  const ISOLAMENTO = 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND';
  const VIDA = 45 * 60 * 1000;
  // Guardião simulado de verdade (processo Node), no protocolo do canal de controle, sem banco.
  const GUARDIAO = [
    "'use strict';",
    "const readline = require('node:readline');",
    "const IMPRESSAO = 'c3'.repeat(32);",
    'let comandos = 0;',
    "const emitir = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    `emitir({ evento: 'ADQUIRIDA', cadeados: 4, impressao: IMPRESSAO, vidaMaximaMs: ${VIDA} });`,
    'const linhas = readline.createInterface({ input: process.stdin });',
    "linhas.on('line', (l) => { const m = /^confirmar ([0-9a-f]{32})$/.exec(l); if (m) { comandos += 1; emitir({ evento: 'CONFIRMADA', id: m[1], impressao: IMPRESSAO, cadeados: 4, comandos }); } else if (l === 'liberar') { emitir({ evento: 'LIBERADA', impressao: IMPRESSAO, liberados: 4, restantes: 0, sessaoEncerrada: true }); process.exit(0); } });",
    "linhas.on('close', () => process.exit(0));",
    '',
  ].join('\n');
  let emissor = null;
  const emissorDoTeste = () => { if (!emissor) emissor = require(PROVEDOR).obterEmissorDeAutorizacoes(); return emissor; };
  const abertos = [];
  afterEach(async () => {
    for (const c of abertos.splice(0)) await c.liberar();
  });

  function criarReleaseBackendComGuardiao(n) {
    const lock = '{"lockfileVersion":3}';
    const sql = '-- 000_a.sql\n';
    return criarRelease({
      componente: 'backend', n,
      arquivos: { 'package.json': '{"engines":{"node":">=22"}}', 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, 'migrations/000_a.sql': sql, 'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha256(sql) } }), 'scripts/guardiao-de-coordenacao.js': GUARDIAO },
      secao: { lockfileSha256: sha256(lock), node: '>=22', migrations: [{ nome: '000_a.sql', sha256: sha256(sql) }], contratos: {} },
    });
  }
  // Configuração oficial num diretório de teste: as mesmas conferências do caminho real, com o dono = usuário do teste.
  function configuracaoOficial(ctx, { habilitado = true, isolamentoRevisado = ISOLAMENTO, modo = 0o640, uidDono = process.getuid() } = {}) {
    const caminho = path.join(tmp(), 'agente-backend.json');
    fs.writeFileSync(caminho, JSON.stringify({ habilitado, isolamentoRevisado }));
    fs.chmodSync(caminho, modo);
    ctx.deps.configuracaoOficial = { caminho, uidDono };
    return caminho;
  }
  async function preparar({ comBaseline = true } = {}) {
    const { instalar, reverter } = carregar();
    const amb = criarAmbiente();
    const obs = { observado: observadoAgora('000_a.sql') };
    // Baseline pelo caminho de teste (só o preparo), com a hora real.
    const livreAgora = async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() });
    if (comBaseline) await instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackendComGuardiao(1), opcoes: obs, deps: { ...criarDeps({ consultarCoordenacao: livreAgora }).deps, agora: Date.now } });
    const alvo = criarReleaseBackendComGuardiao(2);
    const releaseSha256 = sha256(fs.readFileSync(path.join(alvo, 'release.json')));
    const { deps, chamadas } = criarDeps();
    deps.agora = Date.now; // o provedor real carimba a hora real nas consultas
    return { instalar, reverter, amb, obs, alvo, releaseSha256, deps, chamadas };
  }
  // Instância REAL do provedor (iniciador do próprio módulo) com o roteiro da baseline instalada.
  async function guardiaoDaBaseline(amb, { roteiro, baseline = { rotulo: R(1), commit: COMMIT(1) } } = {}) {
    const dir = fs.realpathSync(path.join(amb.releases('backend'), R(1)));
    const caminho = roteiro || path.join(dir, 'scripts', 'guardiao-de-coordenacao.js');
    const coord = require(PROVEDOR).criarCoordenacaoPorGuardiao({
      comando: [process.execPath, caminho], dir, credencial: path.join(amb.raiz, 'credencial.json'), sistema: '7412345678901234567',
      prazos: { adquirirMs: 5000, confirmarMs: 5000, liberarMs: 5000, encerrarMs: 5000 }, baseline, sha256DoRoteiro: sha256(fs.readFileSync(caminho)),
    });
    abertos.push(coord);
    assert.deepEqual(await coord.adquirir(), { ok: true, vidaMaximaMs: VIDA });
    return coord;
  }
  const autorizar = (coord, ctx, extra = {}) => emissorDoTeste().emitir({ id: '9-1', commit: COMMIT(2), rotulo: R(2), releaseSha256: ctx.releaseSha256, expiraEm: new Date(Date.now() + 5 * 60000).toISOString(), consultar: coord.consultar, ...extra });
  const ID_DO_PEDIDO = '9-1';
  const recusada = async (ctx, opcoes, deps = ctx.deps) => {
    const erro = await codigoDe(ctx.instalar({ config: ctx.amb.config, componente: 'backend', release: ctx.alvo, opcoes: { ...ctx.obs, idDoPedido: ID_DO_PEDIDO, ...opcoes }, deps }));
    assert.equal(path.basename(fs.readlinkSync(ctx.amb.link('backend'))), R(1), 'nada trocado');
    assert.equal(ctx.chamadas.reiniciar, 0, 'nada reiniciado');
    return erro;
  };

  test('H-04/CB-01: configuração oficial habilitada, guardião real reconhecido e autorização desta operação: instala', async () => {
    const ctx = await preparar();
    configuracaoOficial(ctx);
    const coord = await guardiaoDaBaseline(ctx.amb);
    ctx.deps.consultarCoordenacao = coord.consultar;
    const r = await ctx.instalar({ config: ctx.amb.config, componente: 'backend', release: ctx.alvo, opcoes: { ...ctx.obs, idDoPedido: ID_DO_PEDIDO, autorizacao: autorizar(coord, ctx) }, deps: ctx.deps });
    assert.equal(r.resultado, 'INSTALADA', JSON.stringify(r));
    assert.equal(path.basename(fs.readlinkSync(ctx.amb.link('backend'))), R(2));
    assert.equal(ctx.chamadas.reiniciar, 1);
  });

  test('C2-01: sem autorização, ou com um objeto igual fabricado à mão: COORDENACAO_NAO_HOMOLOGADA, sem mutação', async () => {
    const ctx = await preparar();
    configuracaoOficial(ctx);
    const coord = await guardiaoDaBaseline(ctx.amb);
    ctx.deps.consultarCoordenacao = coord.consultar;
    assert.equal((await recusada(ctx, {})).codigo, 'COORDENACAO_NAO_HOMOLOGADA');
    const fabricada = Object.freeze({ id: '9-1', commit: COMMIT(2), rotulo: R(2), releaseSha256: ctx.releaseSha256 });
    assert.equal((await recusada(ctx, { autorizacao: fabricada })).codigo, 'COORDENACAO_NAO_HOMOLOGADA');
  });

  test('C2-02/C2-03: autorização de outra release, de outra instância, revogada ou já consumida: recusa', async () => {
    const ctx = await preparar();
    configuracaoOficial(ctx);
    const coord = await guardiaoDaBaseline(ctx.amb);
    const outra = await guardiaoDaBaseline(ctx.amb);
    ctx.deps.consultarCoordenacao = coord.consultar;
    assert.equal((await recusada(ctx, { autorizacao: autorizar(coord, ctx, { releaseSha256: 'f'.repeat(64) }) })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'outra release');
    assert.equal((await recusada(ctx, { autorizacao: autorizar(outra, ctx) })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'outra instância');
    const revogada = autorizar(coord, ctx);
    emissorDoTeste().revogar(revogada);
    assert.equal((await recusada(ctx, { autorizacao: revogada })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'revogada');
    const valida = autorizar(coord, ctx);
    assert.equal((await ctx.instalar({ config: ctx.amb.config, componente: 'backend', release: ctx.alvo, opcoes: { ...ctx.obs, idDoPedido: ID_DO_PEDIDO, autorizacao: valida }, deps: ctx.deps })).resultado, 'INSTALADA');
    const reuso = await codigoDe(ctx.instalar({ config: ctx.amb.config, componente: 'backend', release: ctx.alvo, opcoes: { ...ctx.obs, idDoPedido: ID_DO_PEDIDO, autorizacao: valida }, deps: ctx.deps }));
    assert.equal(reuso.codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'reuso, mesmo para a mesma release');
  });

  test('P2: autorização emitida para outro pedido (outro ID), com a release idêntica: recusa, e não serve mais nem para o próprio pedido', async () => {
    const ctx = await preparar();
    configuracaoOficial(ctx);
    const coord = await guardiaoDaBaseline(ctx.amb);
    ctx.deps.consultarCoordenacao = coord.consultar;
    const deOutroPedido = autorizar(coord, ctx);
    assert.equal((await recusada(ctx, { autorizacao: deOutroPedido, idDoPedido: '9-2' })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'outro ID');
    assert.equal((await recusada(ctx, { autorizacao: deOutroPedido })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'revogada pela tentativa');
    assert.equal((await recusada(ctx, { autorizacao: autorizar(coord, ctx), idDoPedido: undefined })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'sem ID do pedido');
  });

  test('C1-01/C1-02: configuração oficial ausente, desabilitada, com outro isolamento, gravável, de outro dono, link simbólico ou com dois links: recusa', async () => {
    const ctx = await preparar();
    const coord = await guardiaoDaBaseline(ctx.amb);
    ctx.deps.consultarCoordenacao = coord.consultar;
    const casos = [
      ['ausente', () => { ctx.deps.configuracaoOficial = { caminho: path.join(tmp(), 'nao-existe.json'), uidDono: process.getuid() }; }],
      ['desabilitada', () => configuracaoOficial(ctx, { habilitado: false })],
      ['outro isolamento', () => configuracaoOficial(ctx, { isolamentoRevisado: 'OUTRO' })],
      ['gravável por outros', () => configuracaoOficial(ctx, { modo: 0o646 })],
      ['gravável pelo grupo', () => configuracaoOficial(ctx, { modo: 0o660 })],
      ['dono diferente do esperado', () => configuracaoOficial(ctx, { uidDono: 0 })],
      ['link simbólico', () => { const real = configuracaoOficial(ctx); const link = path.join(tmp(), 'link.json'); fs.symlinkSync(real, link); ctx.deps.configuracaoOficial = { caminho: link, uidDono: process.getuid() }; }],
      ['dois links físicos', () => { const real = configuracaoOficial(ctx); fs.linkSync(real, path.join(path.dirname(real), 'outro.json')); }],
      ['diretório gravável por outros', () => { const real = configuracaoOficial(ctx); fs.chmodSync(path.dirname(real), 0o777); }],
    ];
    for (const [nome, preparo] of casos) {
      preparo();
      const erro = await recusada(ctx, { autorizacao: autorizar(coord, ctx) });
      assert.equal(erro.codigo, 'COORDENACAO_NAO_HOMOLOGADA', nome);
    }
  });

  test('C1: sem origem informada vale a constante oficial (dono root); fora de NODE_ENV=test nenhum outro caminho é aceito', () => {
    const I = require(MODULO);
    assert.equal(I.CAMINHO_DA_CONFIGURACAO_OFICIAL, '/etc/safework/cd/agente-backend.json');
    assert.deepEqual({ ...I.origemDaConfiguracaoOficial() }, { caminho: '/etc/safework/cd/agente-backend.json', uidDono: 0 });
    assert.deepEqual({ ...I.origemDaConfiguracaoOficial('/etc/safework/cd/agente-backend.json') }, { caminho: '/etc/safework/cd/agente-backend.json', uidDono: 0 });
    assert.deepEqual({ ...I.origemDaConfiguracaoOficial('/tmp/x.json') }, { caminho: '/tmp/x.json', uidDono: process.getuid() }, 'em teste, outro caminho com o dono = usuário do teste');
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      for (const valor of ['/tmp/x.json', { caminho: '/tmp/x.json', uidDono: 0 }]) {
        assert.throws(() => I.origemDaConfiguracaoOficial(valor), (e) => e.codigo === 'CONFIG_NAO_OFICIAL', JSON.stringify(valor));
      }
      assert.deepEqual({ ...I.origemDaConfiguracaoOficial() }, { caminho: '/etc/safework/cd/agente-backend.json', uidDono: 0 });
    } finally {
      process.env.NODE_ENV = antes;
    }
  });

  test('H-02/H-03: guardião sem posse, com roteiro fora da baseline ou criado para outra baseline: recusa', async () => {
    const ctx = await preparar();
    configuracaoOficial(ctx);
    const perdido = await guardiaoDaBaseline(ctx.amb);
    const autorizacaoDoPerdido = autorizar(perdido, ctx);
    await perdido.liberar();
    assert.equal((await recusada(ctx, { autorizacao: autorizacaoDoPerdido }, { ...ctx.deps, consultarCoordenacao: perdido.consultar })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'sem posse');
    const copia = path.join(tmp(), 'guardiao-de-coordenacao.js');
    fs.writeFileSync(copia, GUARDIAO);
    const fora = await guardiaoDaBaseline(ctx.amb, { roteiro: copia });
    assert.equal((await recusada(ctx, { autorizacao: autorizar(fora, ctx) }, { ...ctx.deps, consultarCoordenacao: fora.consultar })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'roteiro fora da baseline');
    const outraBaseline = await guardiaoDaBaseline(ctx.amb, { baseline: { rotulo: R(1), commit: COMMIT(9) } });
    assert.equal((await recusada(ctx, { autorizacao: autorizar(outraBaseline, ctx) }, { ...ctx.deps, consultarCoordenacao: outraBaseline.consultar })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'outra baseline');
  });

  test('H-06: perda da garantia depois do reconhecimento e antes da troca: COORDENACAO_NAO_CONFIRMADA, nada trocado', async () => {
    const ctx = await preparar();
    configuracaoOficial(ctx);
    const coord = await guardiaoDaBaseline(ctx.amb);
    const executar = ctx.deps.executar;
    const deps = { ...ctx.deps, consultarCoordenacao: coord.consultar, executar: async (...a) => { const r = await executar(...a); await coord.liberar(); return r; } };
    const erro = await recusada(ctx, { autorizacao: autorizar(coord, ctx) }, deps);
    assert.equal(erro.codigo, 'COORDENACAO_NAO_CONFIRMADA');
  });

  test('CB-07: primeira instalação sem baseline e reversão manual do backend continuam bloqueadas com o guardião real', async () => {
    const semBaseline = await preparar({ comBaseline: false });
    configuracaoOficial(semBaseline);
    const p = semBaseline;
    const erro = await codigoDe(p.instalar({ config: p.amb.config, componente: 'backend', release: p.alvo, opcoes: { ...p.obs }, deps: { ...p.deps, consultarCoordenacao: async () => ({}) } }));
    assert.equal(erro.codigo, 'COORDENACAO_NAO_HOMOLOGADA');
    assert.equal(existeLink(p.amb.link('backend')), false);
    const ctx = await preparar();
    const coord = await guardiaoDaBaseline(ctx.amb);
    const rev = await codigoDe(ctx.reverter({ config: ctx.amb.config, componente: 'backend', opcoes: ctx.obs, deps: { ...ctx.deps, consultarCoordenacao: coord.consultar } }));
    assert.equal(rev.codigo, 'COORDENACAO_NAO_HOMOLOGADA');
  });

  // Etapa 4C (D-H1): adoção da primeira release do backend. Reaproveita o preparo do instalador (cópia ancorada,
  // dependências, links persistentes, verificação e metadado) e cria link, versao.json e estado com comprovada:false e
  // o evento ADOCAO. Nunca reinicia nem consulta processo, saúde ou coordenação, e nunca substitui nada: a base precisa
  // estar vazia. comprovada:false não é comprovação operacional (identificar não a dá como íntegra).
  describe('4C (D-H1): adoção da primeira release do backend', () => {
    const SONDA = '// sonda de teste\n';
    function criarReleaseAdotavel(n = 1, { guardiao = true, sonda = true, atual = true } = {}) {
      const lock = '{"lockfileVersion":3}';
      const sql = '-- 000_a.sql\n';
      return criarRelease({
        componente: 'backend', n, atual,
        arquivos: {
          'package.json': '{"engines":{"node":">=22"}}', 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, 'migrations/000_a.sql': sql,
          'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha256(sql) } }),
          ...(guardiao ? { 'scripts/guardiao-de-coordenacao.js': GUARDIAO } : {}), ...(sonda ? { 'scripts/sonda-estado-observado.js': SONDA } : {}),
        },
        secao: { lockfileSha256: sha256(lock), node: '>=22', migrations: [{ nome: '000_a.sql', sha256: sha256(sql) }], contratos: {} },
      });
    }
    const hashDe = (rel) => sha256(fs.readFileSync(path.join(rel, 'release.json')));
    function depsDaAdocao() {
      const chamadas = { executar: 0, proibidas: [] };
      const proibida = (nome) => async () => { chamadas.proibidas.push(nome); throw new Error(`${nome} não pode ser chamado na adoção`); };
      const deps = {
        criarAncora: criarAncoraPorCaminho, agora: Date.now,
        executar: async (cmd, args, opc) => { chamadas.executar += 1; fs.mkdirSync(path.join(opc.cwd, 'node_modules', 'zod'), { recursive: true }); fs.writeFileSync(path.join(opc.cwd, 'node_modules', 'zod', 'index.js'), '1'); },
        reiniciar: proibida('reiniciar'), identificarProcesso: proibida('identificarProcesso'), verificarSaude: proibida('verificarSaude'), consultarCoordenacao: proibida('consultarCoordenacao'),
      };
      return { chamadas, deps };
    }
    const adotar = (amb, rel, opcoes, deps) => require(MODULO).adotarBaselineDoBackend({ config: amb.config, componente: 'backend', release: rel, opcoes, deps });
    const foraDaBase = (amb) => [hashDaArvore(amb.data), hashDaArvore(amb.secrets), hashDaArvore(amb.www)];
    const diarioDe = (amb) => fs.readFileSync(path.join(amb.releases('backend'), 'diario.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

    test('adota a release oficial íntegra: release, metadado, link, versao.json e estado com comprovada:false e evento ADOCAO, sem reiniciar nem consultar nada', async () => {
      const amb = criarAmbiente();
      const rel = criarReleaseAdotavel(1);
      const antesFora = foraDaBase(amb);
      const { deps, chamadas } = depsDaAdocao();
      const r = await adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, deps);
      assert.equal(r.resultado, 'ADOTADA');
      assert.equal(r.rotulo, R(1));
      assert.equal(r.comprovada, false);
      assert.equal(fs.readlinkSync(amb.link('backend')), `.releases/backend/${R(1)}`);
      const raiz = amb.releases('backend');
      const meta = lerJson(path.join(raiz, 'meta', `${R(1)}.json`));
      assert.equal(meta.commit, COMMIT(1));
      assert.equal(meta.releaseSha256, hashDe(rel));
      assert.equal(typeof meta.manifesto['scripts/guardiao-de-coordenacao.js'], 'string');
      assert.equal(typeof meta.manifesto['scripts/sonda-estado-observado.js'], 'string');
      const estado = lerJson(path.join(raiz, 'estado.json'));
      assert.deepEqual({ rotulo: estado.atual.rotulo, commit: estado.atual.commit, comprovada: estado.atual.comprovada }, { rotulo: R(1), commit: COMMIT(1), comprovada: false });
      assert.equal(estado.anterior, null);
      const evento = estado.historico.at(-1);
      assert.equal(evento.evento, 'ADOCAO');
      assert.equal(evento.rotulo, R(1));
      assert.equal(evento.releaseSha256, hashDe(rel));
      assert.equal(evento.comprovada, false);
      assert.equal(evento.reiniciou, false);
      assert.equal(lerJson(path.join(raiz, 'versao.json')).rotulo, R(1));
      assert.equal(fs.readlinkSync(path.join(raiz, R(1), '.env')), path.join(amb.secrets, 'backend.env'), 'link persistente criado sem ler o destino');
      assert.equal(chamadas.executar, 1, 'dependências instaladas uma vez');
      assert.deepEqual(chamadas.proibidas, [], 'nenhum reinício, processo, saúde ou coordenação');
      assert.deepEqual(foraDaBase(amb), antesFora, 'nada fora da base nova mudou');
      assert.deepEqual(diarioDe(amb).map((e) => e.passo), ['INICIO', 'PREPARADA', 'CONCLUIDA']);
      assert.equal(diarioDe(amb)[0].operacao, 'adotar');
      const id = await require(MODULO).identificar({ config: amb.config, componente: 'backend', deps: { criarAncora: criarAncoraPorCaminho } });
      assert.equal(id.instalado, true);
      assert.equal(id.consistente, true, JSON.stringify(id.problemas));
      assert.equal(id.integro, false, 'comprovada:false não é comprovação operacional');
      assert.ok(id.problemas.some((p) => /não teve processo e saúde comprovados/.test(p)));
    });

    test('recusa antes de qualquer mudança: componente estático, sem hash, hash divergente, retroativa, sem guardião, sem sonda e release inválida', async () => {
      const amb = criarAmbiente();
      const { deps } = depsDaAdocao();
      const valida = criarReleaseAdotavel(1);
      const comHash = (rel) => ({ releaseSha256Esperado: hashDe(rel) });
      const casos = [
        ['componente estático', 'ADOCAO_RECUSADA', () => { const p = criarRelease({}); return require(MODULO).adotarBaselineDoBackend({ config: amb.config, componente: 'portal', release: p, opcoes: comHash(p), deps }); }],
        ['componente desconhecido', 'COMPONENTE_DESCONHECIDO', () => require(MODULO).adotarBaselineDoBackend({ config: amb.config, componente: 'x', release: valida, opcoes: comHash(valida), deps })],
        ['sem hash', 'ADOCAO_RECUSADA', () => adotar(amb, valida, {}, deps)],
        ['sem hash, com opt-out de autenticidade', 'ADOCAO_RECUSADA', () => adotar(amb, valida, { semAutenticacao: true }, deps)],
        ['hash divergente', 'RELEASE_NAO_AUTENTICADA', () => adotar(amb, valida, { releaseSha256Esperado: 'f'.repeat(64) }, deps)],
        ['retroativa', 'ADOCAO_RECUSADA', () => { const r = criarReleaseAdotavel(2, { atual: false }); return adotar(amb, r, comHash(r), deps); }],
        ['sem o guardião', 'ADOCAO_RECUSADA', () => { const r = criarReleaseAdotavel(3, { guardiao: false }); return adotar(amb, r, comHash(r), deps); }],
        ['sem a sonda', 'ADOCAO_RECUSADA', () => { const r = criarReleaseAdotavel(4, { sonda: false }); return adotar(amb, r, comHash(r), deps); }],
        ['release inválida', 'RELEASE_INVALIDA', () => adotar(amb, tmp(), { releaseSha256Esperado: 'f'.repeat(64) }, deps)],
      ];
      for (const [nome, codigo, executar] of casos) {
        const erro = await codigoDe(executar());
        assert.equal(erro.codigo, codigo, nome);
        assert.deepEqual(fs.readdirSync(amb.app), [], `${nome}: nada criado na base do backend`);
        assert.deepEqual(fs.readdirSync(amb.www), [], `${nome}: nada criado na base do frontend`);
      }
    });

    test('nunca substitui: adoção repetida, base com link, com diretório no lugar do link ou com árvore de releases existente é recusada sem mudança', async () => {
      let amb = criarAmbiente();
      const rel = criarReleaseAdotavel(1);
      await adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, depsDaAdocao().deps);
      const adotada = hashDaArvore(amb.app);
      const rel2 = criarReleaseAdotavel(2);
      assert.equal((await codigoDe(adotar(amb, rel2, { releaseSha256Esperado: hashDe(rel2) }, depsDaAdocao().deps))).codigo, 'ADOCAO_RECUSADA', 'outra release');
      assert.equal((await codigoDe(adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, depsDaAdocao().deps))).codigo, 'ADOCAO_RECUSADA', 'a mesma release');
      assert.equal(hashDaArvore(amb.app), adotada);
      const ocupacoes = [
        ['diretório no lugar do link (implantação atual fora do layout)', (a) => { fs.mkdirSync(path.join(a.app, 'backend')); fs.writeFileSync(path.join(a.app, 'backend', 'server.js'), 'atual'); }],
        ['link qualquer no lugar', (a) => fs.symlinkSync(a.raiz, path.join(a.app, 'backend'))],
        ['árvore de releases com release', (a) => fs.mkdirSync(path.join(a.app, '.releases', 'backend', R(5)), { recursive: true })],
        ['árvore de releases com metadado', (a) => { fs.mkdirSync(path.join(a.app, '.releases', 'backend', 'meta'), { recursive: true }); fs.writeFileSync(path.join(a.app, '.releases', 'backend', 'meta', `${R(5)}.json`), '{}'); }],
        ['árvore de releases com estado', (a) => { fs.mkdirSync(path.join(a.app, '.releases', 'backend', 'meta'), { recursive: true }); fs.writeFileSync(path.join(a.app, '.releases', 'backend', 'estado.json'), '{"versao":1,"atual":null,"anterior":null,"historico":[]}'); }],
      ];
      for (const [nome, ocupar] of ocupacoes) {
        amb = criarAmbiente();
        ocupar(amb);
        const antes = hashDaArvore(amb.app);
        assert.equal((await codigoDe(adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, depsDaAdocao().deps))).codigo, 'ADOCAO_RECUSADA', nome);
        assert.equal(hashDaArvore(amb.app), antes, `${nome}: nada mudou`);
      }
    });

    test('falha parcial: nas dependências ou depois de publicar, nada fica (release, metadado, link, versao.json, estado); uma nova adoção funciona', async () => {
      const amb = criarAmbiente();
      const rel = criarReleaseAdotavel(1);
      const raiz = amb.releases('backend');
      const restos = () => fs.readdirSync(raiz).filter((n) => n !== 'diario.jsonl' && n !== 'meta').sort();
      const { deps } = depsDaAdocao();
      deps.executar = async () => { throw new Error('npm falhou'); };
      assert.equal((await codigoDe(adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, deps))).codigo, 'DEPENDENCIAS_FALHARAM');
      assert.equal(existeLink(amb.link('backend')), false);
      assert.deepEqual(restos(), []);
      assert.deepEqual(fs.readdirSync(path.join(raiz, 'meta')), []);
      assert.equal(diarioDe(amb).at(-1).passo, 'FALHOU');
      // Falha de E/S ao gravar o versao.json, depois de publicar a release e trocar o link: tudo é desfeito.
      const falhaNoVersao = depsDaAdocao().deps;
      falhaNoVersao.criarAncora = (op) => {
        const A = criarAncoraPorCaminho(op);
        return { ...A, escreverAtomico: (dir, nome, ...resto) => { if (nome === 'versao.json') throw Object.assign(new Error('EIO'), { code: 'EIO' }); return A.escreverAtomico(dir, nome, ...resto); } };
      };
      const erro = await codigoDe(adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, falhaNoVersao));
      assert.ok(erro, 'recusada');
      assert.equal(existeLink(amb.link('backend')), false, 'link desfeito');
      assert.deepEqual(restos(), [], 'release, versao.json e estado desfeitos');
      assert.deepEqual(fs.readdirSync(path.join(raiz, 'meta')), [], 'metadado desfeito');
      assert.equal(diarioDe(amb).at(-1).passo, 'FALHOU');
      const r = await adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, depsDaAdocao().deps);
      assert.equal(r.resultado, 'ADOTADA');
    });

    test('encadeamento: a release adotada é a baseline do guardião real; com C1 e C2 o instalador instala a seguinte, sem eles recusa, e a reversão manual segue bloqueada', async () => {
      const amb = criarAmbiente();
      const r1 = criarReleaseAdotavel(1);
      await adotar(amb, r1, { releaseSha256Esperado: hashDe(r1) }, depsDaAdocao().deps);
      const { instalar, reverter } = carregar();
      const alvo = criarReleaseBackendComGuardiao(2);
      const { deps, chamadas } = criarDeps();
      deps.agora = Date.now;
      const ctx = { instalar, reverter, amb, obs: { observado: observadoAgora('000_a.sql') }, alvo, releaseSha256: hashDe(alvo), deps, chamadas };
      const coord = await guardiaoDaBaseline(amb);
      ctx.deps.consultarCoordenacao = coord.consultar;
      assert.equal((await recusada(ctx, { autorizacao: autorizar(coord, ctx) })).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'sem a configuração oficial (C1)');
      configuracaoOficial(ctx);
      assert.equal((await recusada(ctx, {})).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'sem autorização (C2)');
      const r = await ctx.instalar({ config: amb.config, componente: 'backend', release: alvo, opcoes: { ...ctx.obs, idDoPedido: ID_DO_PEDIDO, autorizacao: autorizar(coord, ctx) }, deps: ctx.deps });
      assert.equal(r.resultado, 'INSTALADA', JSON.stringify(r));
      assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(2));
      assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).anterior.rotulo, R(1), 'a adotada passa a ser o destino de reversão');
      assert.equal((await codigoDe(ctx.reverter({ config: amb.config, componente: 'backend', opcoes: ctx.obs, deps: ctx.deps }))).codigo, 'COORDENACAO_NAO_HOMOLOGADA', 'reversão manual bloqueada');
    });

    test('linha de comando da adoção: só --config, --release e --release-sha256; fora de teste só a configuração oficial; no Linux adota', () => {
      const CLI = path.join(REPO, 'deploy', 'hml', 'instalador', 'adotar-backend.js');
      const rodar = (args, env = { PATH: process.env.PATH, NODE_ENV: 'test' }) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
      for (const args of [[], ['--config', 'x'], ['--config', 'x', '--release', 'y'], ['--config', 'x', '--release', 'y', '--release-sha256'],
        ['--config', 'x', '--release', 'y', '--release-sha256', 'z', '--sem-autenticacao-de-origem'], ['--release', 'y', '--config', 'x', '--release-sha256', 'z', '--permitir-execucao-como-root']]) {
        const r = rodar(args);
        assert.equal(r.status, 1, JSON.stringify(args));
        assert.match(r.stderr, /Adoção recusada \(USO\)/, JSON.stringify(args));
      }
      const foraDeTeste = rodar(['--config', '/tmp/x.json', '--release', '/tmp/r', '--release-sha256', 'a'.repeat(64)], { PATH: process.env.PATH });
      assert.equal(foraDeTeste.status, 1);
      assert.match(foraDeTeste.stderr, /Adoção recusada \(CONFIG_NAO_OFICIAL\)/);
      // Configuração oficial de teste: a seção instalador do agente (backend sem dependências, sem npm de verdade).
      const amb = criarAmbiente();
      const { dependencias, ...backendSemNpm } = amb.config.componentes.backend;
      const caminho = path.join(tmp(), 'agente-backend.json');
      fs.writeFileSync(caminho, JSON.stringify({ habilitado: false, isolamentoRevisado: 'PENDENTE', instalador: { ...amb.config, componentes: { backend: backendSemNpm } } }));
      fs.chmodSync(caminho, 0o640);
      const rel = criarReleaseAdotavel(1);
      const r = rodar(['--config', caminho, '--release', rel, '--release-sha256', hashDe(rel)]);
      if (process.platform === 'linux') {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).resultado, 'ADOTADA');
        assert.equal(fs.readlinkSync(amb.link('backend')), `.releases/backend/${R(1)}`);
      } else {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Adoção recusada \(PLATAFORMA_SEM_ANCORA\)/);
        assert.deepEqual(fs.readdirSync(amb.app), []);
      }
    });

    // Opção 1 da 4C: confirmação explícita da release adotada, por processo (caminho real e PID, pela identidade do
    // serviço) e saúde, sem reinício. Só para a release do evento ADOCAO ainda não comprovada; o estado só muda depois
    // de todas as provas, numa única escrita atômica.
    function depsDaConfirmacao(amb, { cwd, pid = 4242, saude = { ok: true, detalhe: 'ok' }, falhaNaIdentidade } = {}) {
      const chamadas = { identificar: 0, saude: 0, proibidas: [] };
      const proibida = (nome) => async () => { chamadas.proibidas.push(nome); throw new Error(`${nome} não pode ser chamado na confirmação`); };
      const deps = {
        criarAncora: criarAncoraPorCaminho, agora: Date.now, esperar: async () => {},
        identificarProcesso: async () => { chamadas.identificar += 1; if (falhaNaIdentidade) throw falhaNaIdentidade; return { pid, cwd: cwd === undefined ? fs.realpathSync(amb.link('backend')) : cwd }; },
        verificarSaude: async () => { chamadas.saude += 1; return saude; },
        reiniciar: proibida('reiniciar'), executar: proibida('executar'), consultarCoordenacao: proibida('consultarCoordenacao'), lerObservado: proibida('lerObservado'),
      };
      return { deps, chamadas };
    }
    const confirmar = (amb, deps) => require(MODULO).confirmarBaselineAdotada({ config: amb.config, componente: 'backend', deps });
    async function adotada() {
      const amb = criarAmbiente();
      const rel = criarReleaseAdotavel(1);
      await adotar(amb, rel, { releaseSha256Esperado: hashDe(rel) }, depsDaAdocao().deps);
      return { amb, rel, estadoArq: path.join(amb.releases('backend'), 'estado.json') };
    }

    test('confirmação: processo da release adotada, PID e saúde gravam comprovada:true e CONFIRMACAO_DA_ADOCAO, sem reiniciar, instalar, executar nem consultar coordenação', async () => {
      const { amb, estadoArq } = await adotada();
      const { deps, chamadas } = depsDaConfirmacao(amb);
      const r = await confirmar(amb, deps);
      assert.equal(r.resultado, 'ADOCAO_CONFIRMADA');
      assert.equal(r.rotulo, R(1));
      assert.equal(r.comprovada, true);
      assert.equal(r.pid, 4242);
      const estado = lerJson(estadoArq);
      assert.equal(estado.atual.comprovada, true);
      const evento = estado.historico.at(-1);
      assert.deepEqual([evento.evento, evento.rotulo, evento.commit, evento.pid, evento.reiniciou], ['CONFIRMACAO_DA_ADOCAO', R(1), COMMIT(1), 4242, false]);
      assert.equal(chamadas.identificar, 1);
      assert.ok(chamadas.saude >= 1);
      assert.deepEqual(chamadas.proibidas, [], 'nenhum reinício, instalação, comando, migration ou coordenação');
      assert.equal(fs.readlinkSync(amb.link('backend')), `.releases/backend/${R(1)}`, 'o link não muda');
      const id = await require(MODULO).identificar({ config: amb.config, componente: 'backend', deps: { criarAncora: criarAncoraPorCaminho } });
      assert.equal(id.integro, true, JSON.stringify(id.problemas));
    });

    test('confirmação recusada sem mudar o estado: processo em outra release, identidade ausente ou de outro PID, e saúde reprovada', async () => {
      const identidadeInvalida = Object.assign(new Error('IDENTIDADE_DO_SERVICO_INVALIDA'), { codigo: 'IDENTIDADE_DO_SERVICO_INVALIDA' });
      const casos = [
        ['processo em outra release', 'VERSAO_NAO_COMPROVADA', (amb) => depsDaConfirmacao(amb, { cwd: amb.raiz })],
        ['identidade ausente, antiga ou de outro PID', 'VERSAO_NAO_COMPROVADA', (amb) => depsDaConfirmacao(amb, { falhaNaIdentidade: identidadeInvalida })],
        ['saúde reprovada', 'SAUDE_FALHOU', (amb) => depsDaConfirmacao(amb, { saude: { ok: false, detalhe: 'HTTP 503' } })],
      ];
      for (const [nome, codigo, montar] of casos) {
        const { amb, estadoArq } = await adotada();
        const antes = fs.readFileSync(estadoArq);
        const { deps, chamadas } = montar(amb);
        assert.equal((await codigoDe(confirmar(amb, deps))).codigo, codigo, nome);
        assert.deepEqual(fs.readFileSync(estadoArq), antes, `${nome}: estado intacto`);
        assert.deepEqual(chamadas.proibidas, [], nome);
        assert.equal(existeLink(path.join(amb.releases('backend'), '.trava')), false, `${nome}: trava liberada`);
      }
    });

    test('release modificada, metadado divergente do evento ADOCAO ou operação aberta no diário: recusa antes de consultar o processo', async () => {
      const preparos = [
        ['arquivo da release alterado', (amb) => { const arq = path.join(amb.releases('backend'), R(1), 'src', 'server.js'); fs.chmodSync(path.dirname(arq), 0o755); fs.chmodSync(arq, 0o644); fs.writeFileSync(arq, '// adulterado\n'); }],
        ['arquivo a mais na release', (amb) => { const dir = path.join(amb.releases('backend'), R(1), 'src'); fs.chmodSync(dir, 0o755); fs.writeFileSync(path.join(dir, 'extra.js'), '1'); }],
        ['metadado com outro hash do release.json', (amb) => { const arq = path.join(amb.releases('backend'), 'meta', `${R(1)}.json`); const m = lerJson(arq); m.releaseSha256 = 'e'.repeat(64); fs.writeFileSync(arq, JSON.stringify(m)); }],
        ['operação aberta no diário', (amb) => fs.appendFileSync(path.join(amb.releases('backend'), 'diario.jsonl'), `${JSON.stringify({ em: new Date().toISOString(), id: 'x', passo: 'INICIO', operacao: 'instalar' })}\n`)],
      ];
      for (const [nome, adulterar] of preparos) {
        const { amb, estadoArq } = await adotada();
        adulterar(amb);
        const antes = fs.readFileSync(estadoArq);
        const { deps, chamadas } = depsDaConfirmacao(amb);
        assert.equal((await codigoDe(confirmar(amb, deps))).codigo, 'CONFIRMACAO_RECUSADA', nome);
        assert.equal(chamadas.identificar, 0, `${nome}: o processo nem é consultado`);
        assert.deepEqual(fs.readFileSync(estadoArq), antes, `${nome}: estado intacto`);
      }
    });

    test('release não adotada ou já comprovada: recusa sem mudança; a confirmação repetida é recusada sempre do mesmo jeito', async () => {
      const amb = criarAmbiente();
      await carregar().instalar({ config: amb.config, componente: 'backend', release: criarReleaseBackend({ n: 1 }), opcoes: { observado: observadoDe('000_a.sql') }, deps: criarDeps().deps });
      const estadoArq = path.join(amb.releases('backend'), 'estado.json');
      assert.equal((await codigoDe(confirmar(amb, depsDaConfirmacao(amb).deps))).codigo, 'CONFIRMACAO_RECUSADA', 'instalada e comprovada pelo caminho normal');
      const estado = lerJson(estadoArq);
      estado.atual.comprovada = false;
      fs.writeFileSync(estadoArq, JSON.stringify(estado));
      const antes = fs.readFileSync(estadoArq);
      const { deps, chamadas } = depsDaConfirmacao(amb);
      assert.equal((await codigoDe(confirmar(amb, deps))).codigo, 'CONFIRMACAO_RECUSADA', 'não comprovada, mas sem o evento ADOCAO');
      assert.equal(chamadas.identificar, 0);
      assert.deepEqual(fs.readFileSync(estadoArq), antes);
      const { amb: a2, estadoArq: estado2 } = await adotada();
      assert.equal((await confirmar(a2, depsDaConfirmacao(a2).deps)).resultado, 'ADOCAO_CONFIRMADA');
      const confirmado = fs.readFileSync(estado2);
      for (let i = 0; i < 2; i += 1) {
        const c = depsDaConfirmacao(a2);
        assert.equal((await codigoDe(confirmar(a2, c.deps))).codigo, 'CONFIRMACAO_RECUSADA', `repetição ${i + 1}`);
        assert.equal(c.chamadas.identificar, 0);
        assert.deepEqual(fs.readFileSync(estado2), confirmado, 'nada muda');
      }
    });

    test('falha ao gravar o estado: estado.json intacto com comprovada:false, trava liberada, e a confirmação seguinte funciona', async () => {
      const { amb, estadoArq } = await adotada();
      const antes = fs.readFileSync(estadoArq);
      const { deps } = depsDaConfirmacao(amb);
      deps.criarAncora = (op) => {
        const A = criarAncoraPorCaminho(op);
        return { ...A, escreverAtomico: (dir, nome, ...resto) => { if (nome === 'estado.json') throw Object.assign(new Error('EIO'), { code: 'EIO' }); return A.escreverAtomico(dir, nome, ...resto); } };
      };
      assert.ok(await codigoDe(confirmar(amb, deps)));
      assert.deepEqual(fs.readFileSync(estadoArq), antes);
      assert.equal(lerJson(estadoArq).atual.comprovada, false);
      assert.equal(existeLink(path.join(amb.releases('backend'), '.trava')), false);
      assert.equal((await confirmar(amb, depsDaConfirmacao(amb).deps)).resultado, 'ADOCAO_CONFIRMADA');
    });

    test('linha de comando: confirmar só com --config oficial e a identidade do serviço; no Linux confirma pelo processo real e recusa outro PID', async () => {
      const CLI = path.join(REPO, 'deploy', 'hml', 'instalador', 'adotar-backend.js');
      const rodar = (args, env = { PATH: process.env.PATH, NODE_ENV: 'test' }) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 60000 });
      for (const args of [['confirmar'], ['confirmar', '--config'], ['confirmar', '--config', 'x', 'y'], ['confirmar', '--release', 'x'], ['confirmar', '--config', 'x', '--release-sha256', 'z']]) {
        const r = rodar(args);
        assert.equal(r.status, 1, JSON.stringify(args));
        assert.match(r.stderr, /Adoção recusada \(USO\)/, JSON.stringify(args));
      }
      assert.match(rodar(['confirmar', '--config', '/tmp/x.json'], { PATH: process.env.PATH }).stderr, /Adoção recusada \(CONFIG_NAO_OFICIAL\)/);
      const { amb } = await adotada();
      const { dependencias, ...backend } = amb.config.componentes.backend;
      const pidArq = path.join(tmp(), 'servico.pid');
      const componenteCom = (porta) => ({ ...backend, saude: { url: `http://127.0.0.1:${porta}/api/health` }, reinicio: { comando: ['/bin/false'] }, processo: { pidComando: [process.execPath, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(pidArq)}, 'utf8'))`] } });
      const dirIdentidade = tmp();
      fs.chmodSync(dirIdentidade, 0o755);
      const arquivoIdentidade = path.join(dirIdentidade, 'identidade');
      const config = (extra, porta) => {
        const caminho = path.join(tmp(), 'agente-backend.json');
        fs.writeFileSync(caminho, JSON.stringify({ habilitado: false, isolamentoRevisado: 'PENDENTE', instalador: { ...amb.config, componentes: { backend: componenteCom(porta) } }, ...extra }));
        fs.chmodSync(caminho, 0o640);
        return caminho;
      };
      // Até a recusa (sem identidade, ou fora do Linux sem âncora real) a saúde nunca é consultada: a porta só precisa
      // existir na configuração. A reserva de uma porta real acontece só no ramo Linux, onde o serviço sobe.
      const PORTA_NAO_CONSULTADA = 9;
      const identidade = { identidadeDoServico: { arquivo: arquivoIdentidade, uid: process.getuid() } };
      const semIdentidade = rodar(['confirmar', '--config', config({}, PORTA_NAO_CONSULTADA)]);
      assert.equal(semIdentidade.status, 1);
      assert.match(semIdentidade.stderr, /Adoção recusada \(CONFIRMACAO_RECUSADA\)/);
      if (process.platform !== 'linux') {
        assert.match(rodar(['confirmar', '--config', config(identidade, PORTA_NAO_CONSULTADA)]).stderr, /Adoção recusada \(PLATAFORMA_SEM_ANCORA\)/);
        assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).atual.comprovada, false);
        return;
      }
      const porta = await new Promise((ok) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
      const comIdentidade = config(identidade, porta);
      const servico = require('node:child_process').spawn(process.execPath, ['-e', `require('node:http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ status: 'ok', service: 'gestao-epi-api' })); }).listen(${porta}, '127.0.0.1');`], { cwd: fs.realpathSync(amb.link('backend')), stdio: 'ignore' });
      try {
        fs.writeFileSync(pidArq, String(servico.pid));
        for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`http://127.0.0.1:${porta}/api/health`)).ok) break; } catch { /* ainda subindo */ } await new Promise((ok) => setTimeout(ok, 100)); }
        const escrever = (pid) => { fs.writeFileSync(`${arquivoIdentidade}.t`, `${pid} ${fs.realpathSync(amb.link('backend'))}\n`, { mode: 0o644 }); fs.renameSync(`${arquivoIdentidade}.t`, arquivoIdentidade); };
        escrever(servico.pid + 100000);
        const outroPid = rodar(['confirmar', '--config', comIdentidade]);
        assert.equal(outroPid.status, 1);
        assert.match(outroPid.stderr, /Adoção recusada \(VERSAO_NAO_COMPROVADA\)/);
        assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).atual.comprovada, false);
        escrever(servico.pid);
        const ok = rodar(['confirmar', '--config', comIdentidade]);
        assert.equal(ok.status, 0, ok.stderr);
        assert.equal(JSON.parse(ok.stdout).resultado, 'ADOCAO_CONFIRMADA');
        assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).atual.comprovada, true);
      } finally {
        servico.kill('SIGKILL');
      }
    });
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

  // 3B-2B-3B (Opção 1): única exceção nominal, o provedor do guardião carregado sob demanda por coordenacao.js, com
  // recusa em qualquer falha. Sem ele, a pasta continua copiável sozinha (provado abaixo, com execução real).
  const DEPENDENCIA_EXTERNA_PERMITIDA = Object.freeze({ arquivo: 'coordenacao.js', modulo: '../cd/coordenacao-por-guardiao' });
  test('o módulo usa só o núcleo do Node e módulos irmãos (copiável sozinho para o servidor), salvo a exceção nominal do provedor', () => {
    carregar();
    const dir = path.dirname(MODULO);
    const externas = [];
    for (const arquivo of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const fonte = fs.readFileSync(path.join(dir, arquivo), 'utf8');
      for (const m of fonte.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (m[1].startsWith('node:') || m[1].startsWith('./')) continue;
        externas.push({ arquivo, modulo: m[1] });
      }
      assert.doesNotMatch(fonte, /\bsudo\b|child_process'\)\.exec\(|shell:\s*true/, `${arquivo}: sem shell nem sudo`);
    }
    assert.deepEqual(externas, [DEPENDENCIA_EXTERNA_PERMITIDA], 'nenhuma outra dependência fora da pasta');
    const fonte = fs.readFileSync(path.join(dir, 'coordenacao.js'), 'utf8');
    const linha = fonte.split('\n').find((l) => l.includes(DEPENDENCIA_EXTERNA_PERMITIDA.modulo));
    assert.ok(/^\s+return require\(/.test(linha), 'carregada dentro de função, nunca no topo do módulo');
  });

  // Cópia de deploy/hml/instalador/ SOZINHA num diretório temporário, carregada de lá (outra instância dos módulos).
  function instaladorIsolado({ provedor } = {}) {
    const base = tmp();
    const destino = path.join(base, 'instalador');
    fs.mkdirSync(destino);
    for (const f of fs.readdirSync(path.dirname(MODULO)).filter((x) => x.endsWith('.js'))) fs.copyFileSync(path.join(path.dirname(MODULO), f), path.join(destino, f));
    if (provedor !== undefined) { fs.mkdirSync(path.join(base, 'cd')); fs.writeFileSync(path.join(base, 'cd', 'coordenacao-por-guardiao.js'), provedor); }
    return { I: comAutenticidade(require(path.join(destino, 'instalar-release.js'))), C: require(path.join(destino, 'coordenacao.js')), destino };
  }
  // Baseline com o roteiro do guardião no manifesto: a recusa tem de vir da falta do provedor, não da falta do roteiro.
  function releaseBackendComRoteiro(n) {
    const lock = '{"lockfileVersion":3}';
    const sql = '-- 000_a.sql\n';
    return criarRelease({
      componente: 'backend', n,
      arquivos: { 'package.json': '{"engines":{"node":">=22"}}', 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, 'migrations/000_a.sql': sql, 'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha256(sql) } }), 'scripts/guardiao-de-coordenacao.js': '// roteiro\n' },
      secao: { lockfileSha256: sha256(lock), node: '>=22', migrations: [{ nome: '000_a.sql', sha256: sha256(sql) }], contratos: {} },
    });
  }
  function depsIsoladas(C) {
    let pid = 100;
    const homologado = C.homologarProvedorParaTeste(async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() }));
    return {
      criarAncora: criarAncoraPorCaminho, esperar: async () => {}, reiniciar: async () => {}, verificarSaude: async () => ({ ok: true, detalhe: 'ok' }),
      executar: async (cmd, args, opc) => { fs.mkdirSync(path.join(opc.cwd, 'node_modules', 'zod'), { recursive: true }); fs.writeFileSync(path.join(opc.cwd, 'node_modules', 'zod', 'index.js'), '1'); },
      identificarProcesso: async () => { pid += 1; return { pid, cwd: fs.realpathSync(ambienteAtual.link('backend')) }; },
      homologado,
    };
  }
  // O provedor sob demanda pode faltar (pasta copiada sozinha) ou falhar ao carregar: em ambos, o backend recusa
  // antes de qualquer mudança, mesmo com configuração oficial válida, baseline íntegra e um "provedor" que diz LIVRE.
  for (const [nome, provedor] of [['provedor ausente (pasta copiada sozinha)', undefined], ['provedor que falha ao carregar', "throw new Error('falha simulada ao carregar o provedor');\n"]]) {
    test(`Opção 1, ${nome}: o frontend instala de verdade; o backend recusa com COORDENACAO_NAO_HOMOLOGADA, sem mutação`, async () => {
      const { I, C, destino } = instaladorIsolado({ provedor });
      assert.ok(!fs.existsSync(path.join(destino, '..', 'cd', 'coordenacao-por-guardiao.js')) || provedor !== undefined);
      const amb = criarAmbiente();
      const deps = depsIsoladas(C);
      const { homologado, ...semConsulta } = deps;
      const portal = await I.instalar({ config: amb.config, componente: 'portal', release: criarRelease({ n: 1 }), opcoes: {}, deps: semConsulta });
      assert.equal(portal.resultado, 'INSTALADA');
      assert.equal(path.basename(fs.readlinkSync(amb.link('portal'))), R(1));
      const obs = { observado: observadoAgora('000_a.sql') };
      // Baseline pelo caminho de teste da própria cópia; depois, a tentativa de produção sem o provedor.
      await I.instalar({ config: amb.config, componente: 'backend', release: releaseBackendComRoteiro(1), opcoes: obs, deps: { ...semConsulta, consultarCoordenacao: homologado } });
      const caminho = path.join(tmp(), 'agente-backend.json');
      fs.writeFileSync(caminho, JSON.stringify({ habilitado: true, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND' }), { mode: 0o640 });
      assert.equal(I.lerConfiguracaoOficial(I.origemDaConfiguracaoOficial(caminho)).habilitado, true, 'a configuração oficial em si é válida');
      assert.equal(C.guardiaoReconhecido(async () => ({}), { baseline: { rotulo: R(1), commit: COMMIT(1) }, sha256DoRoteiro: 'a'.repeat(64), roteiro: '/x' }), false);
      assert.equal(C.consumirAutorizacaoDoGuardiao(Object.freeze({}), {}), false);
      const antes = hashDaArvore(amb.app);
      const livre = async () => ({ situacao: 'LIVRE', origem: 'diz que é o guardião', consultadoEm: new Date().toISOString() });
      const erro = await codigoDe(I.instalar({ config: amb.config, componente: 'backend', release: releaseBackendComRoteiro(2), opcoes: { ...obs, autorizacao: Object.freeze({ id: '9-1' }) }, deps: { ...semConsulta, consultarCoordenacao: livre, configuracaoOficial: caminho } }));
      assert.match(erro.message, /guardião real/, 'a recusa vem do provedor não reconhecido, depois de configuração e baseline aprovadas');
      assert.equal(erro.codigo, 'COORDENACAO_NAO_HOMOLOGADA');
      assert.equal(hashDaArvore(amb.app), antes, 'nada mudou em disco');
      assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(1));
    });
  }

  test('Opção 1: sem ciclo de importação entre agente, instalador e provedor; cada um carrega sozinho, em qualquer ordem, num processo novo', () => {
    // Grafo estático dos requires relativos de deploy/hml (cd e instalador): nenhum ciclo.
    const raiz = path.join(REPO, 'deploy', 'hml');
    const grafo = new Map();
    for (const sub of ['cd', 'instalador', '.']) {
      const dir = path.join(raiz, sub);
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const abs = path.join(dir, f);
        const deps = [...fs.readFileSync(abs, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((m) => { const p = path.resolve(dir, m[1]); return p.endsWith('.js') ? p : `${p}.js`; });
        grafo.set(abs, deps);
      }
    }
    const estado = new Map();
    const visitar = (no, trilha) => {
      if (estado.get(no) === 'feito') return;
      assert.notEqual(estado.get(no), 'visitando', `ciclo: ${[...trilha, no].map((p) => path.relative(raiz, p)).join(' -> ')}`);
      estado.set(no, 'visitando');
      for (const d of grafo.get(no) || []) visitar(d, [...trilha, no]);
      estado.set(no, 'feito');
    };
    for (const no of grafo.keys()) visitar(no, []);
    // Carga real em processos novos, nas duas ordens, sem aviso de dependência circular.
    const mods = ['deploy/hml/cd/agente-backend.js', 'deploy/hml/instalador/instalar-release.js', 'deploy/hml/instalador/coordenacao.js', 'deploy/hml/cd/coordenacao-por-guardiao.js'].map((m) => path.join(REPO, m));
    for (const ordem of [mods, [...mods].reverse()]) {
      const r = spawnSync(process.execPath, ['--trace-warnings', '-e', `for (const m of ${JSON.stringify(ordem)}) { const e = require(m); if (!e || Object.keys(e).length === 0) throw new Error('exportação vazia: ' + m); } require(${JSON.stringify(mods[2])}).guardiaoReconhecido(async () => ({}), {}); process.stdout.write('ok');`], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'ok');
      assert.doesNotMatch(r.stderr, /circular|Warning/i);
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
