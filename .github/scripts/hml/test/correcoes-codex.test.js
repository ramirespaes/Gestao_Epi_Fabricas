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
 * Correções da auditoria independente do Codex (A01 a A10). Cada teste reproduz um
 * cenário adversarial das sondas P1 a P9 do Codex (ou um cenário equivalente) e foi
 * escrito ANTES da correção correspondente (RED).
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

const VERIF = path.join(REPO, 'deploy', 'hml', 'verificacao', 'verificar-publicacao.js');
const rotuloDoLink = (amb, c) => path.basename(fs.readlinkSync(amb.link(c)));
const diarioDe = (amb, c) => fs.readFileSync(path.join(amb.releases(c), 'diario.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const estadoDe = (amb, c) => lerJson(path.join(amb.releases(c), 'estado.json'));
const FINAIS = ['CONCLUIDA', 'REVERTIDA_AUTOMATICA', 'FALHOU', 'ABORTADA', 'RECUPERADA'];
// A última operação do diário nunca chegou a trocar o link: a recusa veio antes de qualquer mudança.
const ultimaOperacaoSemTroca = (amb, c) => {
  const passos = diarioDe(amb, c);
  const id = passos.at(-1).id;
  return !passos.some((p) => p.id === id && p.passo === 'TROCADA');
};
function arvore(dir) {
  const itens = [];
  const andar = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      let marca = r;
      if (e.isSymbolicLink()) marca += ` -> ${fs.readlinkSync(path.join(abs, e.name))}`;
      else if (e.isFile()) marca += ` #${sha256(fs.readFileSync(path.join(abs, e.name)))}`;
      itens.push(marca);
      if (e.isDirectory()) andar(path.join(abs, e.name), r);
    }
  };
  andar(dir, '');
  return itens.sort();
}
async function comRenameFalho(decide, trabalho) {
  const original = fs.renameSync;
  fs.renameSync = function renameSintetico(origem, destino) {
    if (decide(String(origem), String(destino))) { const e = new Error('EACCES sintético'); e.code = 'EACCES'; throw e; }
    return original.apply(this, arguments);
  };
  try { return await trabalho(); } finally { fs.renameSync = original; }
}
async function instalarDir(amb, componente, dir, deps, extra = {}) {
  const opcoes = componente === 'backend' ? opc(dir, extra) : { releaseSha256Esperado: aprovado(dir), ...extra };
  return inst().instalar({ config: amb.config, componente, release: dir, opcoes, deps });
}
const abrirDiarioComoDiretorio = (amb, c) => {
  const arq = path.join(amb.releases(c), 'diario.jsonl');
  fs.rmSync(arq, { force: true }); fs.mkdirSync(arq);
  return arq;
};

// ===================================================================================== A01

describe('A01 — ancestrais operacionais não podem redirecionar para diretórios persistentes', () => {
  test('.releases como link para a raiz persistente é recusado antes de qualquer gravação', async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.data);
    fs.symlinkSync(amb.data, path.join(amb.www, '.releases'));
    const e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(arvore(amb.data), antes, 'nada foi criado nos dados persistentes');
    assert.equal(existeLink(amb.link('portal')), false);
  });

  test('.releases/<nome> como link para a raiz de segredos é recusado e os segredos ficam intactos', async () => {
    const amb = criarAmbiente();
    const antes = arvore(amb.secrets);
    fs.mkdirSync(path.join(amb.www, '.releases'));
    fs.symlinkSync(amb.secrets, path.join(amb.www, '.releases', 'app'));
    const e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(arvore(amb.secrets), antes);
  });

  test('a limpeza de órfãs e a reconciliação nunca apagam dado persistente alcançado por link', async () => {
    const amb = criarAmbiente();
    const dado = path.join(amb.data, 'app', '.preparo-dado-sintetico');
    fs.mkdirSync(dado, { recursive: true });
    fs.writeFileSync(path.join(dado, 'valor.txt'), 'dado sintético');
    fs.symlinkSync(amb.data, path.join(amb.www, '.releases'));
    const e = await falha(inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps }));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.equal(fs.readFileSync(path.join(dado, 'valor.txt'), 'utf8'), 'dado sintético');
  });

  test('meta/ trocado por link para a raiz persistente depois da primeira instalação bloqueia a seguinte', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const meta = path.join(amb.releases('portal'), 'meta');
    const destino = path.join(amb.data, 'meta-real');
    fs.renameSync(meta, destino);
    fs.symlinkSync(destino, meta);
    const antes = arvore(amb.data);
    const e = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(arvore(amb.data), antes);
  });

  test('redirecionamento de .releases para outro diretório, mesmo não persistente, também é recusado', async () => {
    const amb = criarAmbiente();
    const outro = path.join(amb.raiz, 'outro');
    fs.mkdirSync(outro);
    fs.symlinkSync(outro, path.join(amb.www, '.releases'));
    const e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
    assert.deepEqual(fs.readdirSync(outro), []);
  });

  test('reverter também revalida a árvore operacional antes de agir', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    const real = path.join(amb.www, '.releases');
    fs.renameSync(real, path.join(amb.data, 'releases-real'));
    fs.symlinkSync(path.join(amb.data, 'releases-real'), real);
    const e = await falha(inst().reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps: criarDeps(amb).deps }));
    assert.equal(e.codigo, 'CAMINHO_OPERACIONAL_INVALIDO');
  });
});

// ===================================================================================== A02

describe('A02 — o rollback automático aplica as mesmas travas da reversão manual', () => {
  const migs2 = ['000_a.sql', '001_b.sql'];

  async function prepararSegunda(amb, { depsExtra = {}, observado2 = observadoDe(...migs2), migrations2 = migs2 } = {}) {
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const { deps, chamadas } = criarDeps(amb, depsExtra);
    const dir2 = criarBackend({ n: 2, migrations: migrations2 });
    const promessa = inst().instalar({ config: amb.config, componente: 'backend', release: dir2, opcoes: opc(dir2, { observado: observado2 }), deps });
    return { promessa, chamadas };
  }

  test('banco à frente da release anterior: o rollback é bloqueado, não reinicia e registra estado crítico', async () => {
    const amb = criarAmbiente();
    const { promessa, chamadas } = await prepararSegunda(amb, { depsExtra: { reiniciar: async () => { throw new Error('falha simulada'); } } });
    const e = await falha(promessa);
    assert.equal(e.codigo, 'ROLLBACK_BLOQUEADO');
    assert.match(JSON.stringify(e.detalhes), /BANCO_A_FRENTE_DO_CODIGO/);
    assert.equal(rotuloDoLink(amb, 'backend'), R(2), 'o link não volta para um destino incompatível');
    assert.equal(chamadas.reiniciar, 0);
    const estado = estadoDe(amb, 'backend');
    assert.ok(estado.critico, 'estado crítico registrado');
    assert.equal(estado.critico.motivo, 'ROLLBACK_BLOQUEADO');
    const ultimo = diarioDe(amb, 'backend').at(-1);
    assert.equal(ultimo.passo, 'FALHOU');
    assert.equal(ultimo.motivo, 'ROLLBACK_BLOQUEADO');
  });

  test('o estado crítico aparece na identificação e só é limpo por uma instalação saudável com a exceção explícita (Codex B02)', async () => {
    const amb = criarAmbiente();
    const { promessa } = await prepararSegunda(amb, { depsExtra: { reiniciar: async () => { throw new Error('falha simulada'); } } });
    await falha(promessa);
    const id = await inst().identificar({ config: amb.config, componente: 'backend' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /crític/i);
    const bloqueada = await falha(instalarBackend(amb, 3, criarDeps(amb).deps, { observado: observadoDe(...migs2) }, { migrations: migs2 }));
    assert.equal(bloqueada.codigo, 'ESTADO_CRITICO');
    const r = await instalarBackend(amb, 3, criarDeps(amb).deps, { observado: observadoDe(...migs2), resolverEstadoCritico: true }, { migrations: migs2 });
    assert.equal(r.resultado, 'INSTALADA');
    assert.equal(estadoDe(amb, 'backend').critico || null, null);
    assert.equal((await inst().identificar({ config: amb.config, componente: 'backend' })).integro, true);
  });

  test('release anterior adulterada depois do início da troca bloqueia o rollback', async () => {
    const amb = criarAmbiente();
    let adulterou = false;
    let reinicios = 0;
    const { promessa } = await prepararSegunda(amb, {
      observado2: observadoDe('000_a.sql'),
      migrations2: ['000_a.sql'],
      depsExtra: {
        reiniciar: async () => {
          reinicios += 1;
          if (!adulterou) {
            adulterou = true;
            const dir = path.join(amb.releases('backend'), R(1));
            fs.chmodSync(path.join(dir, 'src'), 0o755); fs.chmodSync(path.join(dir, 'src', 'server.js'), 0o644);
            fs.writeFileSync(path.join(dir, 'src', 'server.js'), '// adulterado\n');
          }
          throw new Error('falha simulada');
        },
      },
    });
    const e = await falha(promessa);
    assert.equal(e.codigo, 'ROLLBACK_BLOQUEADO');
    assert.match(JSON.stringify(e.detalhes), /alterado|integr/i);
    assert.equal(reinicios, 1, 'só a tentativa original reinicia');
    assert.equal(rotuloDoLink(amb, 'backend'), R(2));
  });

  test('coordenação que passa a OCUPADO durante a falha bloqueia o rollback', async () => {
    const amb = criarAmbiente();
    let ocupado = false;
    let reinicios = 0;
    const { promessa } = await prepararSegunda(amb, {
      observado2: observadoDe('000_a.sql'),
      migrations2: ['000_a.sql'],
      depsExtra: {
        consultarCoordenacao: async () => ({ situacao: ocupado ? 'OCUPADO' : 'LIVRE', origem: 'teste', consultadoEm: new Date(AGORA0).toISOString() }),
        reiniciar: async () => { reinicios += 1; ocupado = true; throw new Error('falha simulada'); },
      },
    });
    const e = await falha(promessa);
    assert.equal(e.codigo, 'ROLLBACK_BLOQUEADO');
    assert.match(JSON.stringify(e.detalhes), /OPERACAO_EM_CURSO/);
    assert.equal(reinicios, 1);
  });
});

// ================================================================================= A03 / A04

describe('A03 — qualquer falha entre as trocas de links é recuperável', () => {
  test('falha na troca do link anterior desfaz o link atual e deixa registros e diário coerentes', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    // As primitivas ancoradas renomeiam por nome relativo: a falha é injetada pelo nome da entrada.
    const e = await comRenameFalho((_o, d) => path.basename(d) === 'anterior', () => falha(instalarPortal(amb, 2, criarDeps(amb).deps)));
    assert.equal(e.codigo, 'FALHA_POS_TROCA');
    assert.equal(e.detalhes.desfeito, true);
    assert.equal(rotuloDoLink(amb, 'portal'), R(1));
    const id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.consistente, true, id.problemas.join('; '));
    assert.equal(id.integro, true, id.problemas.join('; '));
    assert.equal(diarioDe(amb, 'portal').at(-1).passo, 'FALHOU');
  });

  test('se o desfazer também falha, o diário continua aberto e a reconciliação seguinte repara os registros', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const nomeDoAtual = path.basename(amb.link('portal'));
    const dir2 = criarRelease({ n: 2 });
    let trocouAtual = false;
    const e = await comRenameFalho((_o, d) => {
      if (path.basename(d) === 'anterior') return true;
      if (path.basename(d) === nomeDoAtual) { if (trocouAtual) return true; trocouAtual = true; }
      return false;
    }, () => falha(instalarDir(amb, 'portal', dir2, criarDeps(amb).deps)));
    assert.equal(e.codigo, 'FALHA_POS_TROCA');
    assert.equal(e.detalhes.desfeito, false);
    assert.ok(!FINAIS.includes(diarioDe(amb, 'portal').at(-1).passo), 'o diário não pode declarar término com o link divergente');
    const rec = await inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps });
    assert.equal(rec.interrompida, true);
    assert.equal(rec.situacao, 'NOVA_EM_USO_SEM_CONFIRMACAO');
    assert.equal(rec.comprovada, false);
    const id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.consistente, true, id.problemas.join('; '));
    assert.equal(id.integro, false, 'sem comprovação a release não é considerada íntegra e confirmada');
    const r = await instalarDir(amb, 'portal', dir2, criarDeps(amb).deps);
    assert.equal(r.resultado, 'CONFIRMADA');
    assert.equal((await inst().identificar({ config: amb.config, componente: 'portal' })).integro, true);
  });

  test('reverter manual: falha depois da troca desfaz o link e fecha o diário', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    const versaoArq = path.join(amb.releases('portal'), 'versao.json');
    fs.rmSync(versaoArq); fs.mkdirSync(versaoArq);
    const e = await falha(inst().reverter({ config: amb.config, componente: 'portal', opcoes: {}, deps: criarDeps(amb).deps }));
    assert.equal(e.codigo, 'FALHA_POS_TROCA');
    assert.equal(e.detalhes.desfeito, true);
    assert.equal(rotuloDoLink(amb, 'portal'), R(2), 'o link volta para a release que estava em uso');
    assert.equal(estadoDe(amb, 'portal').atual.rotulo, R(2));
    assert.ok(FINAIS.includes(diarioDe(amb, 'portal').at(-1).passo));
    fs.rmSync(versaoArq, { recursive: true });
  });

  test('reconciliação de operação abortada com o link já de volta repara estado, versao.json e o link anterior', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    // queda no meio de uma recuperação: o link voltou para r1, mas os registros ainda dizem r2
    fs.rmSync(amb.link('portal'));
    fs.symlinkSync(path.posix.join('.releases', 'app', R(1)), amb.link('portal'));
    fs.appendFileSync(path.join(amb.releases('portal'), 'diario.jsonl'), `${JSON.stringify({ id: 'queda-sintetica', passo: 'INICIO', operacao: 'instalar', de: R(1), para: R(2) })}\n`);
    const rec = await inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps });
    assert.equal(rec.situacao, 'ABORTADA');
    const id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.consistente, true, id.problemas.join('; '));
    assert.equal(estadoDe(amb, 'portal').atual.rotulo, R(1));
    assert.equal(lerJson(path.join(amb.releases('portal'), 'versao.json')).rotulo, R(1));
    assert.notEqual(existeLink(path.join(amb.releases('portal'), 'anterior')) && fs.readlinkSync(path.join(amb.releases('portal'), 'anterior')), R(1), 'o link anterior não pode apontar para a própria release em uso');
  });
});

describe('A04 — nada é declarado concluído sem comprovar release, processo e saúde', () => {
  async function interromper(amb) {
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const dir2 = criarBackend({ n: 2 });
    await inst().instalar({ config: amb.config, componente: 'backend', release: dir2, opcoes: opc(dir2), deps: criarDeps(amb).deps });
    fs.appendFileSync(path.join(amb.releases('backend'), 'diario.jsonl'), `${JSON.stringify({ id: 'queda-sintetica', passo: 'INICIO', operacao: 'instalar', de: R(1), para: R(2) })}\n`);
    return dir2;
  }

  test('reconciliar uma instalação interrompida marca a release como NÃO comprovada e não finge sucesso', async () => {
    const amb = criarAmbiente();
    await interromper(amb);
    const rec = await inst().reconciliar({ config: amb.config, componente: 'backend', deps: criarDeps(amb).deps });
    assert.equal(rec.situacao, 'NOVA_EM_USO_SEM_CONFIRMACAO');
    assert.equal(rec.comprovada, false);
    assert.equal(estadoDe(amb, 'backend').atual.comprovada, false);
    const id = await inst().identificar({ config: amb.config, componente: 'backend' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /comprova/i);
  });

  test('reinstalar a mesma release depois da reconciliação reinicia, prova o processo e a saúde antes de confirmar', async () => {
    const amb = criarAmbiente();
    const dir2 = await interromper(amb);
    await inst().reconciliar({ config: amb.config, componente: 'backend', deps: criarDeps(amb).deps });
    const { deps, chamadas } = criarDeps(amb);
    const r = await instalarDir(amb, 'backend', dir2, deps);
    assert.equal(r.resultado, 'CONFIRMADA');
    assert.ok(chamadas.reiniciar >= 1 && chamadas.processo >= 1 && chamadas.saude >= 1, JSON.stringify(chamadas));
    assert.equal(estadoDe(amb, 'backend').atual.comprovada, true);
    assert.equal((await inst().identificar({ config: amb.config, componente: 'backend' })).integro, true);
  });

  test('a confirmação que não consegue provar o processo volta para a anterior compatível', async () => {
    const amb = criarAmbiente();
    const dir2 = await interromper(amb);
    await inst().reconciliar({ config: amb.config, componente: 'backend', deps: criarDeps(amb).deps });
    let pid = 500;
    const cwdAntigo = () => path.join(amb.releases('backend'), rotuloDoLink(amb, 'backend') === R(2) ? R(1) : R(1));
    const { deps } = criarDeps(amb, { identificarProcesso: async () => { pid += 1; return { pid, cwd: cwdAntigo() }; } });
    const e = await falha(instalarDir(amb, 'backend', dir2, deps));
    assert.equal(e.codigo, 'VERSAO_NAO_COMPROVADA');
    assert.equal(rotuloDoLink(amb, 'backend'), R(1));
  });

  test('idempotência: JA_INSTALADA só com processo e saúde comprovados, sem reiniciar', async () => {
    const amb = criarAmbiente();
    const dir = criarBackend({ n: 1 });
    await instalarDir(amb, 'backend', dir, criarDeps(amb).deps);
    const { deps, chamadas } = criarDeps(amb);
    const r = await instalarDir(amb, 'backend', dir, deps);
    assert.equal(r.resultado, 'JA_INSTALADA');
    assert.ok(chamadas.processo >= 1 && chamadas.saude >= 1, JSON.stringify(chamadas));
    assert.equal(chamadas.reiniciar, 0);
  });

  test('idempotência: processo que não executa a release instalada não vira JA_INSTALADA', async () => {
    const amb = criarAmbiente();
    const dir1 = criarBackend({ n: 1 });
    await instalarDir(amb, 'backend', dir1, criarDeps(amb).deps);
    const dir2 = criarBackend({ n: 2 });
    await instalarDir(amb, 'backend', dir2, criarDeps(amb).deps);
    let pid = 700;
    const { deps, chamadas } = criarDeps(amb, { identificarProcesso: async () => { pid += 1; return { pid, cwd: path.join(amb.releases('backend'), R(1)) }; } });
    const e = await falha(instalarDir(amb, 'backend', dir2, deps));
    assert.notEqual(e.codigo, undefined);
    assert.ok(chamadas.reiniciar >= 1, 'a divergência é tratada com reinício e nova prova, nunca com sucesso silencioso');
  });
});

// ===================================================================================== A05

describe('A05 — a coordenação é revalidada imediatamente antes de cada operação protegida', () => {
  const coord = (amb, regra) => ({ consultarCoordenacao: async () => ({ situacao: regra(), origem: 'teste', consultadoEm: new Date(AGORA0).toISOString() }) });

  test('ocupação surgida durante a instalação de dependências impede a troca e o reinício', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    let ocupado = false;
    const base = criarDeps(amb);
    const { deps, chamadas } = criarDeps(amb, {
      ...coord(amb, () => (ocupado ? 'OCUPADO' : 'LIVRE')),
      executar: async (cmd, args, o) => { ocupado = true; return base.deps.executar(cmd, args, o); },
    });
    const e = await falha(instalarBackend(amb, 2, deps));
    assert.equal(e.codigo, 'OPERACAO_EM_CURSO');
    assert.equal(chamadas.reiniciar, 0);
    assert.equal(rotuloDoLink(amb, 'backend'), R(1));
    assert.ok(ultimaOperacaoSemTroca(amb, 'backend'), 'a recusa veio antes de trocar o link');
  });

  test('ocupação surgida entre a troca do link e o reinício desfaz a troca sem reiniciar', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const { deps, chamadas } = criarDeps(amb, coord(amb, () => (rotuloDoLink(amb, 'backend') === R(2) ? 'OCUPADO' : 'LIVRE')));
    const e = await falha(instalarBackend(amb, 2, deps));
    assert.equal(e.codigo, 'OPERACAO_EM_CURSO');
    assert.equal(chamadas.reiniciar, 0);
    assert.equal(rotuloDoLink(amb, 'backend'), R(1), 'o serviço continua com a release que já roda');
    assert.equal((await inst().identificar({ config: amb.config, componente: 'backend' })).consistente, true);
  });

  test('consulta de coordenação que fica obsoleta durante o preparo não vale mais', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    let salto = 0;
    const base = criarDeps(amb);
    const { deps, chamadas } = criarDeps(amb, {
      agora: () => AGORA0 + salto,
      executar: async (cmd, args, o) => { salto = 6 * 60 * 1000; return base.deps.executar(cmd, args, o); },
    });
    const e = await falha(instalarBackend(amb, 2, deps));
    assert.equal(e.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    assert.equal(chamadas.reiniciar, 0);
    assert.equal(rotuloDoLink(amb, 'backend'), R(1));
    assert.ok(ultimaOperacaoSemTroca(amb, 'backend'), 'a recusa veio antes de trocar o link');
  });

  test('estado observado que fica velho durante o preparo também bloqueia a troca', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    let salto = 0;
    const base = criarDeps(amb);
    const { deps, chamadas } = criarDeps(amb, {
      agora: () => AGORA0 + salto,
      consultarCoordenacao: async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date(AGORA0 + salto).toISOString() }),
      executar: async (cmd, args, o) => { salto = 20 * 60 * 1000; return base.deps.executar(cmd, args, o); },
    });
    const e = await falha(instalarBackend(amb, 2, deps));
    assert.equal(e.codigo, 'INCOMPATIVEL');
    assert.match(JSON.stringify(e.detalhes), /OBSERVADO_ANTIGO/);
    assert.equal(chamadas.reiniciar, 0);
  });

  test('formas malformadas de OCUPADO nunca viram permissão, nem com atestado', () => {
    const { avaliarCoordenacao } = require(COORD);
    const formas = ['OCUPADO', ['OCUPADO'], { situacao: ['OCUPADO'] }, { situacao: { v: 'OCUPADO' } }, { situacao: 'OCUPADO\u0000' }, { situacao: 'OCUPADA' }, { situacao: 'ocupado\n', origem: 'x' }, { estado: { situacao: 'OCUPADO' } }];
    for (const estado of formas) {
      for (const atestado of [true, false]) {
        const r = avaliarCoordenacao({ tipo: 'backend', estado, atestado });
        assert.equal(r.ok, false, JSON.stringify({ estado, atestado }));
        assert.equal(r.bloqueio.codigo, 'OPERACAO_EM_CURSO', JSON.stringify(estado));
      }
    }
  });
});

// ================================================================================= A06 / A07

describe('A06 — identificação publicada inválida ou esperada vazia é rejeitada', () => {
  const { verificarPublicacao } = require(VERIF);
  const ESPERADA = { componente: 'portal', rotulo: R(1), commit: COMMIT(1), manifestoSha256: sha256('m') };
  const POLITICA = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'";
  const corpo = '<p>ok</p>';
  const fetchCom = (versao) => async (url) => new Response(url.endsWith('/versao.json') ? versao : (url.endsWith('/index.html') ? corpo : ''), {
    status: url.endsWith('/versao.json') || url.endsWith('/index.html') ? 200 : 404,
    headers: { 'content-security-policy': POLITICA, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
  });
  const rodar = (versao, esperada = ESPERADA) => verificarPublicacao({ tipo: 'estatico', baseUrl: 'https://audit.invalid', versaoEsperada: esperada, manifesto: { 'index.html': sha256(corpo) }, fetchImpl: fetchCom(versao) });

  test('versao.json que não é um objeto com os quatro campos de texto reprova a identificação', async () => {
    for (const versao of ['null', '[]', '"x"', '123', '{}', JSON.stringify({ ...ESPERADA, commit: 7 }), JSON.stringify({ ...ESPERADA, extra: 1 })]) {
      const r = await rodar(versao);
      const id = r.verificacoes.find((v) => v.nome === 'IDENTIFICACAO');
      assert.equal(id.ok, false, versao);
      assert.equal(r.ok, false, versao);
    }
    assert.equal((await rodar(JSON.stringify(ESPERADA))).ok, true, 'o caso correto continua passando');
  });

  test('identificação esperada vazia ou malformada é erro de entrada, não "tudo igual a undefined"', async () => {
    for (const esperada of [{}, { ...ESPERADA, commit: 'abc' }, { ...ESPERADA, rotulo: 'x' }, { ...ESPERADA, manifestoSha256: 'zz' }, { ...ESPERADA, componente: '' }]) {
      await assert.rejects(() => rodar('{}', esperada), (e) => e.codigo === 'VERIFICACAO_ENTRADA_INVALIDA', JSON.stringify(esperada));
    }
  });
});

describe('A07 — o verificador confere integridade, hash, contagem, caminhos e conteúdo do manifesto', () => {
  const bom = '<p>ok</p>';
  function cenario({ texto, arquivos, hash, commit = COMMIT(1), rotulo = R(1) }) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'manifesto-portal.sha256'), texto);
    const manifestoSha256 = hash || sha256(texto);
    fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ commit, rotulo, atual: true, portal: { arquivos, manifestoSha256 } }));
    const versao = JSON.stringify({ componente: 'portal', commit, rotulo, manifestoSha256 });
    const preload = path.join(dir, 'fetch-sintetico.cjs');
    fs.writeFileSync(preload, `global.fetch=async u=>new Response(u.endsWith('/versao.json')?${JSON.stringify(versao)}:u.endsWith('/index.html')?${JSON.stringify(bom)}:'',{status:u.endsWith('/versao.json')||u.endsWith('/index.html')?200:404,headers:{'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'"}})`);
    const p = spawnSync(process.execPath, ['--require', preload, VERIF, '--base-url', 'https://audit.invalid', '--tipo', 'estatico', '--release', dir, '--componente', 'portal'], { encoding: 'utf8' });
    return p;
  }
  const linha = `${sha256(bom)}  index.html\n`;

  test('controle: manifesto íntegro, contagem certa e hash certo passam', () => {
    const p = cenario({ texto: linha, arquivos: 1 });
    assert.equal(p.status, 0, p.stdout + p.stderr);
  });

  test('manifesto que não bate com o hash do release.json é recusado', () => {
    const p = cenario({ texto: linha, arquivos: 1, hash: sha256('outro manifesto') });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /Verificação recusada \(MANIFESTO_INVALIDO\)/);
  });

  test('contagem de arquivos diferente da declarada é recusada, mesmo com o hash coerente', () => {
    const p = cenario({ texto: linha, arquivos: 2 });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /MANIFESTO_INVALIDO/);
  });

  test('caminho com traversal, absoluto ou com barra invertida é recusado', () => {
    for (const rel of ['../segredo', '/etc/passwd', 'a\\b', './x', 'a//b']) {
      const p = cenario({ texto: `${linha}${sha256('x')}  ${rel}\n`, arquivos: 2 });
      assert.equal(p.status, 1, rel);
      assert.match(p.stderr, /MANIFESTO_INVALIDO/, rel);
    }
  });

  test('caminho duplicado, linha malformada e hash em maiúsculas são recusados', () => {
    for (const texto of [`${linha}${linha}`, `${linha}lixo\n`, `${sha256(bom).toUpperCase()}  index.html\n`, `${sha256(bom)} index.html\n`]) {
      const p = cenario({ texto, arquivos: texto.split('\n').filter(Boolean).length });
      assert.equal(p.status, 1, texto);
      assert.match(p.stderr, /MANIFESTO_INVALIDO/, texto);
    }
  });

  test('linhas repetidas são recusadas mesmo quando a contagem declarada coincide com os caminhos únicos', () => {
    const p = cenario({ texto: `${linha}${linha}`, arquivos: 1 });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /MANIFESTO_INVALIDO.*duplicado/);
  });

  test('commit ou rótulo malformados no release.json são recusados', () => {
    for (const extra of [{ commit: 'abc' }, { rotulo: 'x' }]) {
      const p = cenario({ texto: linha, arquivos: 1, ...extra });
      assert.equal(p.status, 1, JSON.stringify(extra));
      assert.match(p.stderr, /Verificação recusada/);
    }
  });
});

// ===================================================================================== A08

describe('A08 — links persistentes são verificados na instalação e depois dela', () => {
  async function comBackend() {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const dir = path.join(amb.releases('backend'), R(1));
    fs.chmodSync(dir, 0o755);
    return { amb, dir };
  }

  test('link trocado por outro destino é detectado, e uma nova instalação é recusada', async () => {
    const { amb, dir } = await comBackend();
    const outro = path.join(amb.raiz, 'outro.env');
    fs.writeFileSync(outro, 'X=1');
    fs.unlinkSync(path.join(dir, '.env')); fs.symlinkSync(outro, path.join(dir, '.env'));
    const id = await inst().identificar({ config: amb.config, componente: 'backend' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /link persistente/i);
    const e = await falha(instalarBackend(amb, 2, criarDeps(amb).deps));
    assert.equal(e.codigo, 'ATUAL_CORROMPIDA');
  });

  test('link redirecionado para outro arquivo, mesmo dentro das raízes persistentes, é detectado', async () => {
    const { amb, dir } = await comBackend();
    const outro = path.join(amb.data, 'imagens', 'outro.env');
    fs.writeFileSync(outro, 'X=1');
    fs.unlinkSync(path.join(dir, '.env')); fs.symlinkSync(outro, path.join(dir, '.env'));
    const id = await inst().identificar({ config: amb.config, componente: 'backend' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /aponta para outro destino/);
  });

  test('link removido ou substituído por arquivo comum é detectado', async () => {
    const { amb, dir } = await comBackend();
    fs.unlinkSync(path.join(dir, '.env'));
    assert.equal((await inst().identificar({ config: amb.config, componente: 'backend' })).integro, false);
    fs.writeFileSync(path.join(dir, '.env'), 'SEGREDO=copiado');
    const id = await inst().identificar({ config: amb.config, componente: 'backend' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /link persistente/i);
  });

  test('destino que passou a resolver para fora das raízes persistentes é detectado', async () => {
    const { amb } = await comBackend();
    const fora = path.join(amb.raiz, 'fora.env');
    fs.writeFileSync(fora, 'X=1');
    const destino = path.join(amb.secrets, 'backend.env');
    fs.rmSync(destino); fs.symlinkSync(fora, destino);
    const id = await inst().identificar({ config: amb.config, componente: 'backend' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /fora das raízes persistentes/);
  });

  test('instalar com destino que escapa das raízes por link é recusado e nada é publicado', async () => {
    const amb = criarAmbiente();
    const fora = path.join(amb.raiz, 'fora');
    fs.mkdirSync(fora); fs.writeFileSync(path.join(fora, 'x.env'), 'X=1');
    fs.symlinkSync(fora, path.join(amb.data, 'escape'));
    amb.config.componentes.backend.linksPersistentes = [{ nome: '.env', destino: path.join(amb.data, 'escape', 'x.env') }];
    const e = await falha(instalarBackend(amb, 1, criarDeps(amb).deps));
    assert.equal(e.codigo, 'CONFIG_INVALIDA');
    assert.equal(existeLink(amb.link('backend')), false);
  });
});

// ===================================================================================== A09

describe('A09 — procedências vazias ou só com espaços não valem', () => {
  const { avaliarCoordenacao } = require(COORD);
  const { avaliarCompatibilidade } = require(COMPAT);
  const BRANCAS = ['', ' ', '   ', '\t', '\n', '   ', '​'];

  test('coordenação LIVRE com origem em branco vale como DESCONHECIDO', () => {
    for (const origem of BRANCAS) {
      const estado = { situacao: 'LIVRE', origem, consultadoEm: new Date(AGORA0).toISOString() };
      const r = avaliarCoordenacao({ tipo: 'backend', estado, atestado: false, agora: AGORA0 });
      assert.equal(r.ok, false, JSON.stringify(origem));
      assert.equal(r.situacao, 'DESCONHECIDO', JSON.stringify(origem));
    }
  });

  test('estado observado com banco ou origem em branco é inválido', () => {
    const release = { migrations: [{ nome: '000_a.sql' }], contratos: {} };
    for (const campo of ['banco', 'origem']) {
      for (const valor of BRANCAS) {
        const observado = { ...observadoDe('000_a.sql'), [campo]: valor };
        const r = avaliarCompatibilidade({ acao: 'instalar', release, observado, agora: AGORA0 });
        assert.equal(r.ok, false, `${campo}=${JSON.stringify(valor)}`);
        assert.equal(r.bloqueios[0].codigo, 'OBSERVADO_INVALIDO');
      }
    }
  });
});

// ===================================================================================== A10

describe('A10 — protocolo durável de diário e transições', () => {
  test('falha de sincronização em disco impede a operação antes de qualquer troca', async () => {
    const amb = criarAmbiente();
    const original = fs.fsyncSync;
    fs.fsyncSync = () => { const e = new Error('EIO sintético'); e.code = 'EIO'; throw e; };
    let e;
    try { e = await falha(instalarPortal(amb, 1, criarDeps(amb).deps)); } finally { fs.fsyncSync = original; }
    assert.ok(e, 'a falha de fsync não pode ser engolida');
    assert.equal(existeLink(amb.link('portal')), false);
  });

  test('cada passo do diário e cada gravação de estado passam por fsync', async () => {
    const amb = criarAmbiente();
    const original = fs.fsyncSync;
    let n = 0;
    fs.fsyncSync = function contar(fd) { n += 1; return original.call(this, fd); };
    try { await instalarPortal(amb, 1, criarDeps(amb).deps); } finally { fs.fsyncSync = original; }
    const passos = diarioDe(amb, 'portal').length;
    assert.ok(n >= passos + 3, `fsync chamado ${n} vezes para ${passos} passos de diário`);
  });

  test('falha ao registrar um passo intermediário aborta antes da troca, sem sucesso silencioso', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const base = criarDeps(amb);
    const { deps } = criarDeps(amb, { executar: async (cmd, args, o) => { abrirDiarioComoDiretorio(amb, 'backend'); return base.deps.executar(cmd, args, o); } });
    const e = await falha(instalarBackend(amb, 2, deps));
    assert.ok(e.codigo, 'erro explícito');
    assert.equal(rotuloDoLink(amb, 'backend'), R(1));
    fs.rmSync(path.join(amb.releases('backend'), 'diario.jsonl'), { recursive: true, force: true });
  });

  test('falha ao registrar o término não é silenciosa: o resultado traz aviso DIARIO_NAO_GRAVADO', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const { deps } = criarDeps(amb, { verificarSaude: async () => { abrirDiarioComoDiretorio(amb, 'backend'); return { ok: true }; } });
    const r = await instalarBackend(amb, 2, deps);
    assert.equal(r.resultado, 'INSTALADA');
    assert.ok(r.avisos.some((a) => a.codigo === 'DIARIO_NAO_GRAVADO'), JSON.stringify(r.avisos));
    fs.rmSync(path.join(amb.releases('backend'), 'diario.jsonl'), { recursive: true, force: true });
  });

  test('cauda truncada por queda não engole a entrada seguinte e é informada na identificação', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    fs.appendFileSync(path.join(amb.releases('portal'), 'diario.jsonl'), '{"id":"queda","passo":"INIC');
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    const passos = diarioDe(amb, 'portal');
    const ultimoId = passos.at(-1).id;
    const doUltimo = passos.filter((p) => p.id === ultimoId).map((p) => p.passo);
    assert.deepEqual(doUltimo, ['INICIO', 'PREPARADA', 'TROCADA', 'CONCLUIDA']);
    const id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.diarioLinhasIlegiveis, 1);
    assert.equal(id.integro, true);
  });

  test('diário gravado com permissão restrita ao dono', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    assert.equal(fs.statSync(path.join(amb.releases('portal'), 'diario.jsonl')).mode & 0o077, 0);
  });
});

// ============================================================ endurecimentos correlatos

describe('Nomes herdados de Object nunca contornam as comparações por nome', () => {
  test('contrato observado chamado "constructor" que a release não declara é CONTRATO_DESCONHECIDO', () => {
    const { avaliarCompatibilidade } = require(COMPAT);
    // "constructor" é o único nome herdado de Object que também é um nome de contrato válido (minúsculas e hífen).
    const observado = { ...observadoDe('000_a.sql'), contratos: { constructor: 1 } };
    const r = avaliarCompatibilidade({ acao: 'instalar', release: { migrations: [{ nome: '000_a.sql' }], contratos: {} }, observado, agora: AGORA0 });
    assert.equal(r.ok, false);
    assert.ok(r.bloqueios.some((b) => b.codigo === 'CONTRATO_DESCONHECIDO'));
  });

  test('arquivo de release chamado "constructor" é aceito e arquivo extra "toString" é detectado como extra', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1, arquivos: { 'index.html': '<p>1</p>', constructor: 'c' } });
    await instalarDir(amb, 'portal', dir, criarDeps(amb).deps);
    const raiz = path.join(amb.releases('portal'), R(1));
    fs.chmodSync(raiz, 0o755);
    fs.writeFileSync(path.join(raiz, 'toString'), 'extra');
    const id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /extra: toString/);
  });
});

describe('Primitivas do núcleo: guarda de remoção e sincronização em disco', () => {
  const abrir = () => { const A = criarAncoraPorCaminho({}); const dir = tmp(); return { A, dir, base: A.abrirBase(dir) }; };

  test('removerArvore remove o filho direto legítimo e nunca atravessa um link', () => {
    const { A, dir, base } = abrir();
    const outro = tmp();
    fs.mkdirSync(path.join(outro, 'dado')); fs.writeFileSync(path.join(outro, 'dado', 'x'), '1');
    fs.symlinkSync(outro, path.join(dir, 'ponte'));
    A.removerArvore(base, 'ponte');
    assert.equal(existeLink(path.join(dir, 'ponte')), false, 'o link foi removido');
    assert.equal(fs.readFileSync(path.join(outro, 'dado', 'x'), 'utf8'), '1', 'o alvo do link não foi tocado');
    fs.mkdirSync(path.join(dir, '.preparo-x'));
    A.removerArvore(base, '.preparo-x');
    assert.equal(existeLink(path.join(dir, '.preparo-x')), false);
    assert.throws(() => A.removerArvore(base, '../fora'), (e) => e.codigo === 'CAMINHO_OPERACIONAL_INVALIDO');
    A.fecharTudo();
  });

  test('anexar, escreverAtomico e trocarLink sincronizam arquivo e diretório a cada gravação', () => {
    const { A, dir, base } = abrir();
    const original = fs.fsyncSync;
    let n = 0;
    fs.fsyncSync = function contar(fd) { n += 1; return original.call(this, fd); };
    try {
      A.anexar(base, 'diario.jsonl', '{"passo":"INICIO"}\n');
      assert.ok(n >= 2, `criação do diário: arquivo e diretório (${n})`);
      const depoisDoPrimeiro = n;
      A.anexar(base, 'diario.jsonl', '{"passo":"PREPARADA"}\n');
      assert.ok(n - depoisDoPrimeiro >= 1, 'cada entrada seguinte também é sincronizada');
      const antesDoAtomico = n;
      A.escreverAtomico(base, 'a.json', '{}');
      assert.ok(n - antesDoAtomico >= 2, 'conteúdo e renomeação');
      const antesDoLink = n;
      A.trocarLink(base, 'l', 'alvo');
      assert.ok(n - antesDoLink >= 1, 'troca de link');
    } finally {
      fs.fsyncSync = original;
    }
    assert.equal(fs.readFileSync(path.join(dir, 'diario.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
    A.fecharTudo();
  });

  test('fsync que falha com EIO propaga em cada primitiva, sem temporário esquecido', () => {
    const { A, dir, base } = abrir();
    const original = fs.fsyncSync;
    fs.fsyncSync = () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; };
    try {
      assert.throws(() => A.anexar(base, 'd.jsonl', 'x\n'), /EIO/);
      assert.throws(() => A.escreverAtomico(base, 'a.json', '{}'), /EIO/);
      assert.throws(() => A.trocarLink(base, 'l', 'alvo'), /EIO/);
    } finally {
      fs.fsyncSync = original;
    }
    assert.equal(existeLink(path.join(dir, 'a.json.tmp-' + process.pid)), false, 'sem temporário esquecido');
    A.fecharTudo();
  });

  test('a exigência de durabilidade é de cada âncora, nunca global: duas instalações concorrentes não se afetam (T04)', async () => {
    const ctxA = criarAncoraPorCaminho({ exigirDurabilidade: true });
    const ctxB = criarAncoraPorCaminho({ exigirDurabilidade: false });
    const dirA = tmp(); const dirB = tmp();
    const original = fs.fsyncSync;
    const mapa = new Map(); const abrirOrig = fs.openSync; const fecharOrig = fs.closeSync;
    fs.openSync = function (p, ...r) { const fd = abrirOrig.call(this, p, ...r); mapa.set(fd, String(p)); return fd; };
    fs.closeSync = function (fd) { mapa.delete(fd); return fecharOrig.call(this, fd); };
    fs.fsyncSync = function (fd) { const p = mapa.get(fd); if (p && fs.statSync(p).isDirectory()) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); return original.call(this, fd); };
    try {
      const a = ctxA.abrirBase(dirA); const b = ctxB.abrirBase(dirB);
      assert.doesNotThrow(() => ctxB.escreverAtomico(b, 'x.json', '{}'), 'B tolera e contabiliza');
      assert.throws(() => ctxA.escreverAtomico(a, 'x.json', '{}'), (e) => e.codigo === 'DURABILIDADE_NAO_SUPORTADA', 'A continua exigindo, mesmo depois de B concluir');
      assert.ok(ctxB.durabilidade.naoSuportado >= 1);
      assert.equal(ctxA.durabilidade.naoSuportado, 0);
    } finally { fs.fsyncSync = original; fs.openSync = abrirOrig; fs.closeSync = fecharOrig; }
    ctxA.fecharTudo(); ctxB.fecharTudo();
  });
});
