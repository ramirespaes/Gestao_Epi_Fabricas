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
 * Correções da auditoria de segurança da Fase 2 (B-1, B-2, A-1, A-2, A-5, A-7, A-8,
 * M-1 a M-5). Cada teste reproduz um cenário adversarial demonstrado pelas sondas
 * S1 a S15 e foi escrito ANTES da correção correspondente (RED).
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
// Testes e desenvolvimento: âncora por caminho, sem garantia contra substituição concorrente (reconhecida de forma explícita).
// A âncora real (/proc/self/fd, Linux) tem testes próprios em ancora.test.js e correcoes-ancora.test.js.
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

describe('B-1 — OCUPADO nunca vira autorização (sonda S1)', () => {
  const MALFORMADOS = [{ situacao: 'OCUPADO' }, { situacao: 'OCUPADO', origem: '' }, { situacao: 'OCUPADO', origem: 7 }, { situacao: 'OCUPADO', origem: null }, { situacao: 'ocupado', origem: 'x' }, { situacao: ' OCUPADO ', origem: 'x' }, { situacao: 'Ocupado' }, { situacao: 'OCUPADO', origem: 'x', consultadoEm: 'lixo' }];

  test('avaliarCoordenacao bloqueia OCUPADO malformado, em outra caixa ou com espaços, mesmo com atestado', () => {
    const { avaliarCoordenacao } = require(COORD);
    for (const estado of MALFORMADOS) {
      for (const atestado of [true, false]) {
        const r = avaliarCoordenacao({ tipo: 'backend', estado, atestado });
        assert.equal(r.ok, false, JSON.stringify({ estado, atestado }));
        assert.equal(r.bloqueio.codigo, 'OPERACAO_EM_CURSO', JSON.stringify(estado));
        assert.equal(r.atestadoManual, false);
      }
    }
  });

  test('DESCONHECIDO bloqueia, com ou sem atestado (Codex B05), e OCUPADO bem formado segue bloqueando', () => {
    const { avaliarCoordenacao } = require(COORD);
    assert.equal(avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'DESCONHECIDO', origem: 'x' }, atestado: false }).ok, false);
    assert.equal(avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'DESCONHECIDO', origem: 'x' }, atestado: true }).ok, false);
    assert.equal(avaliarCoordenacao({ tipo: 'backend', estado: { situacao: 'OCUPADO', origem: 'x' }, atestado: true }).bloqueio.codigo, 'OPERACAO_EM_CURSO');
  });

  test('no instalador, provedor que devolve OCUPADO malformado bloqueia a troca mesmo com atestado e não altera nada', async () => {
    const amb = criarAmbiente();
    for (const estado of MALFORMADOS.slice(0, 4)) {
      const { deps } = criarDeps(amb, { consultarCoordenacao: async () => estado });
      const erro = await falha(instalarBackend(amb, 1, deps, { atestarSemOperacao: true }));
      assert.equal(erro.codigo, 'OPERACAO_EM_CURSO', JSON.stringify(estado));
      assert.equal(existeLink(amb.link('backend')), false);
    }
  });
});

describe('B-2 — falha de reinício, de versão em execução ou de saúde aciona recuperação segura (sonda S2)', () => {
  test('reinício que falha na instalação volta para a anterior, reinicia de novo e registra estado e histórico coerentes', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    let n = 0;
    const ruim = criarDeps(amb, { reiniciar: async () => { n += 1; if (n === 1) throw new Error('systemctl falhou'); } });
    const erro = await falha(instalarBackend(amb, 2, ruim.deps));
    assert.equal(erro.codigo, 'REINICIO_FALHOU');
    assert.deepEqual([erro.detalhes.reverteu, erro.detalhes.motivo, erro.detalhes.reinicioAposReversao, erro.detalhes.saudeAposReversao], [true, 'REINICIO', true, true]);
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(1));
    assert.equal(n, 2);
    const estado = lerJson(path.join(amb.releases('backend'), 'estado.json'));
    assert.equal(estado.atual.rotulo, R(1));
    const ultimo = estado.historico.at(-1);
    assert.deepEqual([ultimo.evento, ultimo.rotulo, ultimo.motivo], ['REVERSAO_AUTOMATICA', R(2), 'REINICIO']);
    assert.equal(lerJson(path.join(amb.releases('backend'), 'versao.json')).rotulo, R(1));
  });

  test('reinício que falha também na recuperação deixa o estado coerente com o link e diz que o serviço precisa de atenção', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const ruim = criarDeps(amb, { reiniciar: async () => { throw new Error('serviço não sobe'); } });
    const erro = await falha(instalarBackend(amb, 2, ruim.deps));
    assert.equal(erro.codigo, 'REINICIO_FALHOU');
    assert.deepEqual([erro.detalhes.reverteu, erro.detalhes.reinicioAposReversao, erro.detalhes.saudeAposReversao], [true, false, false]);
    const estado = lerJson(path.join(amb.releases('backend'), 'estado.json'));
    assert.equal(estado.atual.rotulo, path.basename(fs.readlinkSync(amb.link('backend'))));
    assert.equal(estado.atual.rotulo, R(1));
    assert.equal(estado.historico.at(-1).reinicioAposReversao, false);
    assert.equal(lerJson(path.join(amb.releases('backend'), 'versao.json')).rotulo, R(1));
  });

  test('falha de reinício na primeira instalação não deixa link publicado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb, { reiniciar: async () => { throw new Error('falhou'); } });
    const erro = await falha(instalarBackend(amb, 1, deps));
    assert.equal(erro.codigo, 'REINICIO_FALHOU');
    assert.equal(erro.detalhes.reverteu, false);
    assert.equal(existeLink(amb.link('backend')), false);
    assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).atual, null);
  });

  test('processo antigo que continua respondendo é reprovado: sem prova de que a release nova roda, volta para a anterior', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const antigo = criarDeps(amb, { identificarProcesso: async () => ({ pid: 4242, cwd: path.join(amb.releases('backend'), R(1)) }) });
    const erro = await falha(instalarBackend(amb, 2, antigo.deps));
    assert.equal(erro.codigo, 'VERSAO_NAO_COMPROVADA');
    assert.equal(erro.detalhes.reverteu, true);
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(1));
    assert.equal(erro.detalhes.motivo, 'VERSAO', 'a saúde não substitui a prova de versão');
    assert.equal(erro.detalhes.saudeAposReversao, true);
  });

  test('mesmo diretório mas o mesmo PID de antes (nada reiniciou) também é reprovado', async () => {
    const amb = criarAmbiente();
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    const mesmoPid = criarDeps(amb, { identificarProcesso: async () => ({ pid: 777, cwd: fs.realpathSync(amb.link('backend')) }) });
    const erro = await falha(instalarBackend(amb, 2, mesmoPid.deps));
    assert.equal(erro.codigo, 'VERSAO_NAO_COMPROVADA');
    assert.match(erro.message, /reinici/i);
  });

  test('o backend exige a prova de versão configurada; sem ela e sem opt-out explícito nada é alterado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    delete deps.identificarProcesso;
    const erro = await falha(instalarBackend(amb, 1, deps));
    assert.equal(erro.codigo, 'VERSAO_NAO_COMPROVAVEL');
    assert.equal(fs.existsSync(amb.releases('backend')), false);
    const r = await instalarBackend(amb, 1, deps, { semComprovacaoDeVersao: true });
    assert.equal(r.resultado, 'INSTALADA');
    assert.equal(lerJson(path.join(amb.releases('backend'), 'estado.json')).historico.at(-1).versaoComprovada, false);
  });

  test('reversão manual com falha de reinício registra o fato, mantém o link coerente e não faz vaivém', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    for (const n of [1, 2]) await instalarBackend(amb, n, deps);
    const ruim = criarDeps(amb, { reiniciar: async () => { throw new Error('falhou'); } });
    const erro = await falha(inst().reverter({ config: amb.config, componente: 'backend', opcoes: { observado: observadoDe('000_a.sql') }, deps: ruim.deps }));
    assert.equal(erro.codigo, 'REINICIO_FALHOU_APOS_REVERSAO');
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(1));
    const estado = lerJson(path.join(amb.releases('backend'), 'estado.json'));
    assert.equal(estado.atual.rotulo, R(1));
    assert.deepEqual([estado.historico.at(-1).evento, estado.historico.at(-1).reinicio], ['REVERSAO_MANUAL', false]);
  });

  test('qualquer erro inesperado depois da troca desfaz o link antes de propagar', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const versaoArq = path.join(amb.releases('portal'), 'versao.json');
    fs.rmSync(versaoArq); fs.mkdirSync(versaoArq);
    const erro = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.equal(erro.codigo, 'FALHA_POS_TROCA');
    assert.equal(erro.detalhes.desfeito, true);
    assert.equal(path.basename(fs.readlinkSync(amb.link('portal'))), R(1), 'o link volta para a release anterior');
    const estado = lerJson(path.join(amb.releases('portal'), 'estado.json'));
    assert.equal(estado.atual.rotulo, R(1));
    const ultimo = fs.readFileSync(path.join(amb.releases('portal'), 'diario.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([ultimo.passo, ultimo.motivo], ['FALHOU', 'POS_TROCA']);
    fs.rmSync(versaoArq, { recursive: true });
  });
});

describe('A-1 — identidade imutável da release (sonda S3)', () => {
  test('mesmo rótulo com outro commit, manifesto ou release.json é recusado, sem informar o commit errado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    const a = criarRelease({ n: 1, commit: 'a'.repeat(40) });
    await inst().instalar({ config: amb.config, componente: 'portal', release: a, opcoes: { releaseSha256Esperado: aprovado(a) }, deps });
    const outroCommit = criarRelease({ n: 1, commit: 'b'.repeat(40) });
    const outroConteudo = criarRelease({ n: 1, commit: 'a'.repeat(40), arquivos: { 'index.html': '<p>OUTRO</p>' } });
    for (const dir of [outroCommit, outroConteudo]) {
      const erro = await falha(inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir) }, deps }));
      assert.equal(erro.codigo, 'IDENTIDADE_DIVERGENTE');
    }
    assert.equal(fs.readFileSync(path.join(amb.link('portal'), 'index.html'), 'utf8'), '<p>v1</p>');
  });

  test('a mesma release de novo é idempotente e informa o commit realmente instalado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    const dir = criarRelease({ n: 1, commit: 'a'.repeat(40) });
    await inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir) }, deps });
    const r = await inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir) }, deps });
    assert.deepEqual([r.resultado, r.commit], ['JA_INSTALADA', 'a'.repeat(40)]);
  });

  test('reaproveitar diretório de release que já existe (reinstalar uma antiga) também exige a mesma identidade', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    await instalarPortal(amb, 1, deps);
    await instalarPortal(amb, 2, deps);
    const forjada = criarRelease({ n: 1, commit: 'c'.repeat(40) });
    const erro = await falha(inst().instalar({ config: amb.config, componente: 'portal', release: forjada, opcoes: { releaseSha256Esperado: aprovado(forjada), permitirAnterior: true }, deps }));
    assert.equal(erro.codigo, 'IDENTIDADE_DIVERGENTE');
    assert.equal(path.basename(fs.readlinkSync(amb.link('portal'))), R(2));
  });
});

describe('A-2 — consistência entre manifesto, migrations declaradas e engines (sonda S4)', () => {
  test('migration no pacote que o release.json não declara, ou declarada sem arquivo, é recusada', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    for (const criar of [{ migrations: ['000_a.sql', '001_b.sql'], declaradas: ['000_a.sql'] }, { migrations: ['000_a.sql'], declaradas: ['000_a.sql', '001_b.sql'] }]) {
      const dir = criarBackend({ n: 1, ...criar });
      const erro = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps }));
      assert.equal(erro.codigo, 'INTEGRIDADE_DIVERGENTE', JSON.stringify(criar));
      assert.match(erro.message, /migrations/);
      assert.equal(existeLink(amb.link('backend')), false);
    }
  });

  test('hash de migration declarado diferente do arquivo, ou checksums.json divergente, é recusado', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    const dir1 = criarBackend({ n: 1 });
    const f = path.join(dir1, 'release.json'); const j = lerJson(f); j.backend.migrations[0].sha256 = 'f'.repeat(64); fs.writeFileSync(f, JSON.stringify(j));
    const dir2 = criarBackend({ n: 2, checksumsAdulterado: { algoritmo: 'sha256', migrations: { '000_a.sql': 'e'.repeat(64) } } });
    const dir3 = criarBackend({ n: 3, checksumsAdulterado: { algoritmo: 'md5', migrations: {} } });
    for (const dir of [dir1, dir2, dir3]) {
      const erro = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps }));
      assert.equal(erro.codigo, 'INTEGRIDADE_DIVERGENTE');
    }
  });

  test('engines do package.json diferente do declarado é recusado', async () => {
    const amb = criarAmbiente();
    const dir = criarBackend({ n: 1, engines: '>=18' });
    const erro = await falha(inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: opc(dir), deps: criarDeps(amb).deps }));
    assert.equal(erro.codigo, 'INTEGRIDADE_DIVERGENTE');
    assert.match(erro.message, /engines|node/i);
  });
});

describe('A-5 — contratos do estado observado são obrigatórios (sonda S6)', () => {
  test('observado sem o campo contratos é inválido; com objeto vazio é aceito', () => {
    const { avaliarCompatibilidade } = require(COMPAT);
    const base = { banco: 'hml', origem: 's', coletadoEm: new Date().toISOString(), migrations: ['000_a.sql'] };
    const release = { migrations: [{ nome: '000_a.sql' }], contratos: {} };
    assert.deepEqual(avaliarCompatibilidade({ acao: 'instalar', release, observado: base }).bloqueios.map((b) => b.codigo), ['OBSERVADO_INVALIDO']);
    assert.equal(avaliarCompatibilidade({ acao: 'instalar', release, observado: { ...base, contratos: {} } }).ok, true);
    for (const contratos of [null, [], 'x', 3]) assert.equal(avaliarCompatibilidade({ acao: 'instalar', release, observado: { ...base, contratos } }).ok, false);
  });

  test('release sem o campo contratos também é inválida', () => {
    const { avaliarCompatibilidade } = require(COMPAT);
    const observado = { banco: 'hml', origem: 's', coletadoEm: new Date().toISOString(), migrations: ['000_a.sql'], contratos: {} };
    assert.deepEqual(avaliarCompatibilidade({ acao: 'instalar', release: { migrations: [{ nome: '000_a.sql' }] }, observado }).bloqueios.map((b) => b.codigo), ['RELEASE_INVALIDA']);
  });
});

describe('A-7 — autenticidade da release por hash externo previamente aprovado', () => {
  test('sem hash aprovado a instalação é recusada por padrão, e nada é criado', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1 });
    const erro = await falha(inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: {}, deps: criarDeps(amb).deps }));
    assert.equal(erro.codigo, 'ORIGEM_NAO_AUTENTICADA');
    assert.equal(fs.existsSync(amb.releases('portal')), false);
  });

  test('hash errado, malformado ou de outra release é recusado; o certo passa', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1 });
    const outra = criarRelease({ n: 2 });
    for (const h of ['0'.repeat(64), 'xyz', '', aprovado(outra), aprovado(dir).toUpperCase().slice(0, 63)]) {
      const erro = await falha(inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: h }, deps: criarDeps(amb).deps }));
      assert.ok(['RELEASE_NAO_AUTENTICADA', 'ORIGEM_NAO_AUTENTICADA'].includes(erro.codigo), `${h}: ${erro.codigo}`);
    }
    assert.equal(fs.existsSync(amb.releases('portal')), false);
    const ok = await inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir) }, deps: criarDeps(amb).deps });
    assert.equal(ok.resultado, 'INSTALADA');
  });

  test('release.json trocado depois da aprovação (mesmo coerente com o manifesto) é detectado', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1 });
    const hashAprovado = aprovado(dir);
    const f = path.join(dir, 'release.json'); const j = lerJson(f); j.geradoEm = '2026-12-31T00:00:00.000Z'; fs.writeFileSync(f, JSON.stringify(j));
    const erro = await falha(inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: hashAprovado }, deps: criarDeps(amb).deps }));
    assert.equal(erro.codigo, 'RELEASE_NAO_AUTENTICADA');
  });

  test('o opt-out semAutenticacao existe, é explícito e fica registrado como NAO_VERIFICADA', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1 });
    const r = await inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { semAutenticacao: true }, deps: criarDeps(amb).deps });
    assert.equal(r.resultado, 'INSTALADA');
    const ev = lerJson(path.join(amb.releases('portal'), 'estado.json')).historico.at(-1);
    assert.equal(ev.autenticidade, 'NAO_VERIFICADA');
    const meta = lerJson(path.join(amb.releases('portal'), 'meta', `${R(1)}.json`));
    assert.equal(meta.releaseSha256, aprovado(dir));
  });

  test('com hash aprovado o histórico registra HASH_EXTERNO e o hash do release.json', async () => {
    const amb = criarAmbiente();
    const dir = criarRelease({ n: 1 });
    await inst().instalar({ config: amb.config, componente: 'portal', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir) }, deps: criarDeps(amb).deps });
    const ev = lerJson(path.join(amb.releases('portal'), 'estado.json')).historico.at(-1);
    assert.deepEqual([ev.autenticidade, ev.releaseSha256], ['HASH_EXTERNO', aprovado(dir)]);
  });

  test('linha de comando: sem --release-sha256 recusa com código 1; com o hash instala; o opt-out é uma flag explícita', () => {
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config), { mode: 0o600 });
    const dir = criarRelease({ n: 1 });
    const rodar = (...a) => spawnSync(process.execPath, [MODULO, ...a], { encoding: 'utf8' });
    const sem = rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', dir);
    assert.equal(sem.status, 1);
    assert.match(sem.stderr, /ORIGEM_NAO_AUTENTICADA/);
    const errado = rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', '0'.repeat(64));
    assert.equal(errado.status, 1);
    assert.match(errado.stderr, /RELEASE_NAO_AUTENTICADA/);
    const ok = rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', aprovado(dir));
    const optOut = rodar('instalar', '--config', cfg, '--componente', 'portal', '--release', criarRelease({ n: 2 }), '--sem-autenticacao-de-origem');
    if (process.platform === 'linux') {
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(optOut.status, 0, optOut.stderr);
      assert.equal(lerJson(path.join(amb.releases('portal'), 'estado.json')).historico.at(-1).autenticidade, 'NAO_VERIFICADA');
    } else {
      // Sem a âncora real por descritor (/proc/self/fd) a linha de comando bloqueia a instalação, em vez de degradar.
      for (const r of [ok, optOut]) {
        assert.equal(r.status, 1);
        assert.match(r.stderr, /PLATAFORMA_SEM_ANCORA/);
      }
      assert.equal(fs.existsSync(amb.releases('portal')), false, 'nada foi criado');
    }
  });
});

describe('A-8 — rastreabilidade da coordenação, do estado observado e da fonte', () => {
  test('cada instalação e reversão do backend registra coordenação, observado, usuário e fontes', async () => {
    const amb = criarAmbiente();
    const { deps } = criarDeps(amb);
    const fontes = { observado: { arquivo: '/tmp/obs.json', sha256: 'a'.repeat(64) }, coordenacao: { arquivo: '/tmp/coord.json', sha256: 'b'.repeat(64) } };
    await instalarBackend(amb, 1, deps);
    await instalarBackend(amb, 2, deps, { fontes, atestarSemOperacao: false });
    const ev = lerJson(path.join(amb.releases('backend'), 'estado.json')).historico.at(-1);
    assert.deepEqual(ev.coordenacao, { situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date(AGORA0).toISOString(), atestadoManual: false });
    assert.deepEqual(ev.observado, { banco: 'hml', origem: 'sonda-teste', coletadoEm: new Date(AGORA0).toISOString(), migrations: 1, contratos: {} });
    assert.equal(ev.usuario, 'operador-teste');
    assert.deepEqual(ev.fontes, fontes);
    await inst().reverter({ config: amb.config, componente: 'backend', opcoes: { observado: observadoDe('000_a.sql') }, deps });
    const rev = lerJson(path.join(amb.releases('backend'), 'estado.json')).historico.at(-1);
    assert.equal(rev.evento, 'REVERSAO_MANUAL');
    assert.equal(rev.coordenacao.situacao, 'LIVRE');
    assert.equal(rev.observado.banco, 'hml');
    assert.equal(rev.usuario, 'operador-teste');
  });

  test('o atestado humano não cobre mais o estado DESCONHECIDO: a instalação é recusada e nada é registrado como atestado (Codex B05)', async () => {
    const amb = criarAmbiente();
    const { deps, chamadas } = criarDeps(amb, { consultarCoordenacao: async () => ({ situacao: 'DESCONHECIDO', origem: 'nenhuma trava do D-ORF-6 homologada' }) });
    const e = await falha(instalarBackend(amb, 1, deps, { atestarSemOperacao: true }));
    assert.equal(e.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    assert.equal(chamadas.reiniciar, 0);
    assert.equal(existeLink(amb.link('backend')), false);
  });

  test('frontend registra coordenação não aplicável e observado nulo', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const ev = lerJson(path.join(amb.releases('portal'), 'estado.json')).historico.at(-1);
    assert.deepEqual([ev.coordenacao.situacao, ev.observado], ['NAO_APLICAVEL', null]);
  });
});

describe('M-1 — recuperação de falhas intermediárias (sonda S12)', () => {
  test('falha ao gravar os metadados depois do rename não deixa release órfã e a nova tentativa funciona', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const meta = path.join(amb.releases('portal'), 'meta');
    fs.chmodSync(meta, 0o555);
    const erro = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    fs.chmodSync(meta, 0o755);
    assert.ok(erro);
    assert.equal(fs.existsSync(path.join(amb.releases('portal'), R(2))), false, 'sem diretório órfão');
    assert.deepEqual(fs.readdirSync(amb.releases('portal')).filter((n) => n.startsWith('.preparo')), []);
    assert.equal((await instalarPortal(amb, 2, criarDeps(amb).deps)).resultado, 'INSTALADA');
  });

  test('releases órfãs (sem metadados, fora de uso) e preparos antigos são limpos no começo da próxima operação', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const raiz = amb.releases('portal');
    fs.mkdirSync(path.join(raiz, R(5)));
    fs.writeFileSync(path.join(raiz, R(5), 'x.html'), 'órfã');
    fs.mkdirSync(path.join(raiz, `.preparo-${R(6)}-99999`));
    fs.mkdirSync(path.join(raiz, 'pasta-do-operador'));
    const r = await instalarPortal(amb, 2, criarDeps(amb).deps);
    assert.equal(r.resultado, 'INSTALADA');
    assert.equal(fs.existsSync(path.join(raiz, R(5))), false);
    assert.equal(fs.existsSync(path.join(raiz, `.preparo-${R(6)}-99999`)), false);
    assert.equal(fs.existsSync(path.join(raiz, 'pasta-do-operador')), true, 'nada que não seja release ou preparo é tocado');
    assert.equal(fs.existsSync(path.join(raiz, R(1))), true);
  });

  test('uma release sem metadados que está em uso nunca é removida', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    fs.rmSync(path.join(amb.releases('portal'), 'meta', `${R(1)}.json`));
    const erro = await falha(instalarPortal(amb, 2, criarDeps(amb).deps));
    assert.ok(erro);
    assert.equal(fs.existsSync(path.join(amb.releases('portal'), R(1), 'index.html')), true);
  });
});

describe('M-2 — retenção e liberação da trava não derrubam uma instalação concluída (sonda S13)', () => {
  test('erro ao limpar releases antigas vira aviso; o resultado é INSTALADA e o histórico registra', async () => {
    const amb = criarAmbiente();
    // Frontend estático não tem gancho de saúde (política): o gancho que torna a raiz somente leitura vem do backend.
    for (const n of [1, 2, 3]) await instalarBackend(amb, n, criarDeps(amb).deps);
    const raiz = amb.releases('backend');
    const { deps } = criarDeps(amb, { verificarSaude: async () => { fs.chmodSync(raiz, 0o555); return { ok: true }; } });
    let r; let erro;
    try { r = await instalarBackend(amb, 4, deps); } catch (e) { erro = e; }
    fs.chmodSync(raiz, 0o755);
    fs.rmSync(path.join(raiz, '.trava'), { recursive: true, force: true });
    assert.equal(erro, undefined, erro && erro.message);
    assert.equal(r.resultado, 'INSTALADA');
    assert.ok(r.avisos.some((a) => a.codigo === 'POS_TROCA_INCOMPLETA' || a.codigo === 'RETENCAO_FALHOU'), JSON.stringify(r.avisos));
    assert.equal(path.basename(fs.readlinkSync(amb.link('backend'))), R(4));
  });
});

describe('M-3 — diário de operações, reconciliação e consistência (sonda S8)', () => {
  test('o diário registra INICIO, PREPARADA, TROCADA e CONCLUIDA com o mesmo identificador no frontend, e REINICIANDO no backend', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    const linhas = fs.readFileSync(path.join(amb.releases('portal'), 'diario.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const segunda = linhas.filter((l) => l.id === linhas.at(-1).id);
    assert.deepEqual(segunda.map((l) => l.passo), ['INICIO', 'PREPARADA', 'TROCADA', 'CONCLUIDA'], 'frontend estático nunca reinicia nada');
    assert.deepEqual([segunda[0].operacao, segunda[0].de, segunda[0].para], ['instalar', R(1), R(2)]);
    await instalarBackend(amb, 1, criarDeps(amb).deps);
    await instalarBackend(amb, 2, criarDeps(amb).deps);
    const doBackend = fs.readFileSync(path.join(amb.releases('backend'), 'diario.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ultima = doBackend.filter((l) => l.id === doBackend.at(-1).id);
    // REINICIANDO (Codex B02) é gravado antes de cada reinício; só existe quando há serviço a reiniciar.
    assert.deepEqual(ultima.map((l) => l.passo), ['INICIO', 'PREPARADA', 'TROCADA', 'REINICIANDO', 'CONCLUIDA']);
  });

  test('operação interrompida entre as trocas é reconciliada: anterior, estado e versao.json voltam a bater com o link', async () => {
    const amb = criarAmbiente();
    for (const n of [1, 2, 3]) await instalarPortal(amb, n, criarDeps(amb).deps);
    const raiz = amb.releases('portal');
    fs.unlinkSync(path.join(raiz, 'anterior')); fs.symlinkSync(R(1), path.join(raiz, 'anterior'));
    const e = lerJson(path.join(raiz, 'estado.json')); e.atual = { rotulo: R(2), commit: COMMIT(2) }; e.anterior = { rotulo: R(1), commit: COMMIT(1) }; fs.writeFileSync(path.join(raiz, 'estado.json'), JSON.stringify(e));
    fs.appendFileSync(path.join(raiz, 'diario.jsonl'), `${JSON.stringify({ em: 'x', id: 'queda', passo: 'INICIO', operacao: 'instalar', de: R(2), para: R(3) })}\n${JSON.stringify({ em: 'x', id: 'queda', passo: 'TROCADA' })}\n`);
    const r = await inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps });
    assert.equal(r.interrompida, true);
    assert.equal(fs.readlinkSync(path.join(raiz, 'anterior')), R(2));
    const estado = lerJson(path.join(raiz, 'estado.json'));
    assert.deepEqual([estado.atual.rotulo, estado.anterior.rotulo], [R(3), R(2)]);
    assert.equal(lerJson(path.join(raiz, 'versao.json')).rotulo, R(3));
    const ultimo = fs.readFileSync(path.join(raiz, 'diario.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(ultimo.passo, 'RECUPERADA');
    // Codex A04: reconciliar alinha os registros ao link, mas não comprova a release; ela fica pendente de confirmação.
    const id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.consistente, true, id.problemas.join('; '));
    assert.equal(id.integro, false);
    assert.match(id.problemas.join(' | '), /comprova/);
    assert.equal(r.comprovada, false);
  });

  test('operação interrompida antes da troca é marcada como abortada e não muda o link', async () => {
    const amb = criarAmbiente();
    for (const n of [1, 2]) await instalarPortal(amb, n, criarDeps(amb).deps);
    const raiz = amb.releases('portal');
    fs.appendFileSync(path.join(raiz, 'diario.jsonl'), `${JSON.stringify({ em: 'x', id: 'queda2', passo: 'INICIO', operacao: 'instalar', de: R(2), para: R(3) })}\n`);
    const r = await inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps });
    assert.deepEqual([r.interrompida, r.situacao], [true, 'ABORTADA']);
    assert.equal(path.basename(fs.readlinkSync(amb.link('portal'))), R(2));
  });

  test('instalar e reverter reconciliam sozinhos antes de agir e avisam', async () => {
    const amb = criarAmbiente();
    for (const n of [1, 2]) await instalarPortal(amb, n, criarDeps(amb).deps);
    fs.appendFileSync(path.join(amb.releases('portal'), 'diario.jsonl'), `${JSON.stringify({ em: 'x', id: 'q', passo: 'INICIO', operacao: 'instalar', de: R(2), para: R(3) })}\n`);
    const r = await instalarPortal(amb, 3, criarDeps(amb).deps);
    assert.ok(r.avisos.some((a) => a.codigo === 'OPERACAO_ANTERIOR_INTERROMPIDA'));
  });

  test('identificar detecta versao.json e estado.json adulterados ou desatualizados em relação ao link', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const raiz = amb.releases('portal');
    const v = lerJson(path.join(raiz, 'versao.json')); v.commit = 'f'.repeat(40); fs.writeFileSync(path.join(raiz, 'versao.json'), JSON.stringify(v));
    let id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.deepEqual([id.consistente, id.integro], [false, false]);
    assert.ok(id.problemas.some((p) => p.includes('versao.json')));
    await inst().reconciliar({ config: amb.config, componente: 'portal', deps: criarDeps(amb).deps });
    const e = lerJson(path.join(raiz, 'estado.json')); e.atual.rotulo = R(9); fs.writeFileSync(path.join(raiz, 'estado.json'), JSON.stringify(e));
    id = await inst().identificar({ config: amb.config, componente: 'portal' });
    assert.equal(id.consistente, false);
    assert.ok(id.problemas.some((p) => p.includes('estado.json')));
  });

  test('versao.json público expõe só o necessário para o verificador: componente, rótulo, commit e hash do manifesto', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    assert.deepEqual(Object.keys(lerJson(path.join(amb.releases('portal'), 'versao.json'))).sort(), ['commit', 'componente', 'manifestoSha256', 'rotulo']);
  });
});

describe('M-4 e M-5 — saúde com identidade do serviço, configuração e gravação seguras', () => {
  test('a verificação de saúde da linha de comando exige status ok E o nome do serviço esperado', async () => {
    const http = require('node:http');
    const { depsDoConfig } = inst();
    for (const [corpo, esperado] of [[{ status: 'ok', service: 'gestao-epi-api' }, true], [{ status: 'ok', service: 'outro-servico' }, false], [{ status: 'ok' }, false], [{ status: 'erro', service: 'gestao-epi-api' }, false]]) {
      const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(corpo)); });
      await new Promise((resolve) => { s.listen(0, '127.0.0.1', resolve); });
      try {
        const deps = depsDoConfig({ saude: { url: `http://127.0.0.1:${s.address().port}/api/health`, timeoutMs: 2000 } }, {});
        assert.equal((await deps.verificarSaude()).ok, esperado, JSON.stringify(corpo));
      } finally { s.closeAllConnections(); await new Promise((resolve) => { s.close(resolve); }); }
    }
  });

  test('o comando de dependências precisa de caminho absoluto para o npm', () => {
    const { validarConfig } = inst();
    const amb = criarAmbiente();
    amb.config.componentes.backend.dependencias.comando[0] = 'npm';
    assert.throws(() => validarConfig(amb.config), (e) => e.codigo === 'CONFIG_INVALIDA');
    amb.config.componentes.backend.dependencias.comando[0] = '/usr/local/bin/npm';
    assert.doesNotThrow(() => validarConfig(amb.config));
  });

  test('lerConfigSegura recusa link simbólico, arquivo gravável por grupo ou outros e dono diferente', () => {
    const { lerConfigSegura } = inst();
    const dir = tmp();
    const arq = path.join(dir, 'c.json');
    fs.writeFileSync(arq, '{"a":1}', { mode: 0o600 });
    assert.deepEqual(lerConfigSegura(arq), { a: 1 });
    for (const modo of [0o664, 0o666, 0o620]) { fs.chmodSync(arq, modo); assert.throws(() => lerConfigSegura(arq), (e) => e.codigo === 'CONFIG_INSEGURA', modo.toString(8)); }
    fs.chmodSync(arq, 0o600);
    const link = path.join(dir, 'l.json'); fs.symlinkSync(arq, link);
    assert.throws(() => lerConfigSegura(link), (e) => e.codigo === 'CONFIG_INSEGURA');
    assert.throws(() => lerConfigSegura(arq, { uid: process.getuid() + 1 }), (e) => e.codigo === 'CONFIG_INSEGURA');
    fs.chmodSync(dir, 0o777);
    assert.throws(() => lerConfigSegura(arq), (e) => e.codigo === 'CONFIG_INSEGURA', 'diretório gravável por outros');
    fs.chmodSync(dir, 0o755);
    assert.throws(() => lerConfigSegura(path.join(dir, 'nao-existe.json')), (e) => e.codigo === 'CONFIG_INSEGURA');
  });

  test('o instalador recusa rodar como root, salvo opt-out explícito', () => {
    const { verificarContextoDeExecucao } = inst();
    assert.throws(() => verificarContextoDeExecucao({ uid: 0 }), (e) => e.codigo === 'EXECUCAO_COMO_ROOT');
    assert.doesNotThrow(() => verificarContextoDeExecucao({ uid: 1000 }));
    assert.doesNotThrow(() => verificarContextoDeExecucao({ uid: 0, permitirRoot: true }));
  });

  test('a linha de comando recusa configuração gravável por outros', () => {
    const amb = criarAmbiente();
    const cfg = path.join(tmp(), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify(amb.config));
    fs.chmodSync(cfg, 0o666);
    const dir = criarRelease({ n: 1 });
    const r = spawnSync(process.execPath, [MODULO, 'instalar', '--config', cfg, '--componente', 'portal', '--release', dir, '--release-sha256', aprovado(dir)], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CONFIG_INSEGURA/);
    assert.equal(fs.existsSync(amb.releases('portal')), false);
  });

  test('gravação temporária não segue link simbólico pré-existente para dado persistente (sonda S10)', async () => {
    const amb = criarAmbiente();
    await instalarPortal(amb, 1, criarDeps(amb).deps);
    const alvo = path.join(amb.data, 'imagens', 'a.png');
    fs.writeFileSync(alvo, 'ORIGINAL');
    fs.symlinkSync(alvo, path.join(amb.releases('portal'), `estado.json.tmp-${process.pid}`));
    fs.symlinkSync(alvo, path.join(amb.releases('portal'), `versao.json.tmp-${process.pid}`));
    await instalarPortal(amb, 2, criarDeps(amb).deps);
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'ORIGINAL');
    assert.equal(lerJson(path.join(amb.releases('portal'), 'estado.json')).atual.rotulo, R(2));
  });
});
