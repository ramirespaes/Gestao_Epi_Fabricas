'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const raiz = path.resolve(__dirname, '../../../..');
const protocolo = require(path.join(raiz, 'deploy/hml/cd/protocolo.js'));
const carregar = () => protocolo;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-52-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const commit = 'a'.repeat(40), rotulo = 'hml-20261107T120000-aaaaaaa';
  const release = { commit, rotulo, atual: true, geradoEm: '2026-11-07T12:00:00.000Z' };
  for (const c of ['portal', 'painel']) {
    fs.mkdirSync(path.join(dir, c));
    fs.writeFileSync(path.join(dir, c, 'index.html'), c);
    const m = `${hash(c)}  index.html\n`;
    fs.writeFileSync(path.join(dir, `manifesto-${c}.sha256`), m);
    release[c] = { arquivos: 1, manifestoSha256: hash(m) };
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));
  return { dir, commit, rotulo, releaseSha256: hash(fs.readFileSync(path.join(dir, 'release.json'))) };
}
test('release íntegra mantém exatamente o SHA aprovado; avanço posterior da main não é consultado', t => {
  const f = fixture(t);
  assert.equal(carregar().conferirRelease(f).release.commit, f.commit);
});
test('recusa SHA de outro commit e hash externo diferente', t => {
  const f = fixture(t);
  for (const alteracao of [{ commit: 'b'.repeat(40) }, { releaseSha256: 'b'.repeat(64) }, { rotulo: 'hml-20261107T120001-aaaaaaa' }])
    assert.throws(() => carregar().conferirRelease({ ...f, ...alteracao }));
});
test('recusa alteração de conteúdo, arquivo extra e link', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'portal/index.html'), 'adulterado');
  assert.throws(() => carregar().conferirRelease(f));
  fs.writeFileSync(path.join(f.dir, 'portal/index.html'), 'portal');
  fs.writeFileSync(path.join(f.dir, 'portal/extra.js'), 'x');
  assert.throws(() => carregar().conferirRelease(f));
  fs.unlinkSync(path.join(f.dir, 'portal/extra.js'));
  fs.symlinkSync('index.html', path.join(f.dir, 'portal/link'));
  assert.throws(() => carregar().conferirRelease(f));
});
test('recusa traversal mesmo com manifesto e hash externo recalculados', t => {
  const f = fixture(t), m = `${hash('portal')}  ../release.json\n`;
  const release = JSON.parse(fs.readFileSync(path.join(f.dir, 'release.json')));
  release.portal.manifestoSha256 = hash(m);
  fs.writeFileSync(path.join(f.dir, 'manifesto-portal.sha256'), m);
  fs.writeFileSync(path.join(f.dir, 'release.json'), JSON.stringify(release));
  f.releaseSha256 = hash(fs.readFileSync(path.join(f.dir, 'release.json')));
  assert.throws(() => carregar().conferirRelease(f));
});
const { publicar } = require(path.join(raiz, 'deploy/hml/cd/publicar'));
const { aplicar, validarConfiguracao } = require(path.join(raiz, 'deploy/hml/cd/agente'));
function pedido(f, extra = {}) {
  const agora = Date.now();
  return { versao: 1, repositorio: protocolo.REPO, id: '123-1', commit: f.commit, rotulo: f.rotulo, releaseSha256: f.releaseSha256, blobSha256: 'a'.repeat(64), permitirAnterior: false, criadoEm: new Date(agora).toISOString(), expiraEm: new Date(agora + 480000).toISOString(), ...extra };
}
test('pedido bloqueia repositório diferente, expiração, futuro, retroativo e tipo inválido', t => {
  const p = pedido(fixture(t));
  for (const extra of [{ repositorio: 'outro/repo' }, { id: '../x' }, { expiraEm: new Date(0).toISOString() }, { criadoEm: new Date(Date.now() + 120000).toISOString() }, { permitirAnterior: 'true' }, { rotulo: p.rotulo + '-retroativo' }, { extra: true }])
    assert.throws(() => protocolo.validarPedido({ ...p, ...extra }));
  assert.equal(protocolo.validarPedido(p), p);
});
test('formato de transporte não extrai traversal, duplicatas nem caminhos absolutos', t => {
  const f = fixture(t);
  for (const pares of [[['../fora', 'eA==']], [['/fora', 'eA==']], [['portal/a', 'eA=='], ['portal/a', 'eA==']], [['portal/./a', 'eA==']]])
    assert.throws(() => protocolo.extrair(Buffer.from(JSON.stringify(pares)), path.join(f.dir, 'extraido')));
  assert.equal(fs.existsSync(path.join(f.dir, 'extraido')), false);
  const b = protocolo.empacotar(f.dir, f), destino = path.join(f.dir, 'extraido');
  protocolo.extrair(b, destino);
  assert.equal(protocolo.conferirRelease({ ...f, dir: destino }).release.commit, f.commit);
});
test('publisher envia blob antes de autorização e só aprova recibo vinculado ao mesmo SHA e execução', async t => {
  const f = fixture(t), enviados = [], id = '123-1';
  const s3 = { put: async (key, b) => enviados.push([key, b]), get: async () => Buffer.from(JSON.stringify({ id, commit: f.commit, releaseSha256: f.releaseSha256, estado: 'SUCESSO', verificado: true })) };
  await publicar({ ...f, id, s3 });
  assert.deepEqual(enviados.map(p => p[0]), ['hml/blobs/123-1.json', 'hml/pedidos/123-1.json']);
  const p = JSON.parse(enviados[1][1]);
  assert.equal(p.blobSha256, hash(enviados[0][1]));
  for (const extra of [{ id: '124-1' }, { commit: 'b'.repeat(40) }, { releaseSha256: 'b'.repeat(64) }, { estado: 'FALHOU' }, { verificado: false }])
    assert.throws(() => protocolo.validarRecibo({ id, commit: f.commit, releaseSha256: f.releaseSha256, estado: 'SUCESSO', verificado: true, ...extra }, p));
});
test('publisher falha fechado antes de transmitir conteúdo inválido ou depois de timeout', async t => {
  const f = fixture(t), chamadas = [];
  const s3 = { put: async k => chamadas.push(k), get: async () => null };
  await assert.rejects(publicar({ ...f, commit: 'b'.repeat(40), id: '123-1', s3 }));
  assert.equal(chamadas.length, 0);
  await assert.rejects(publicar({ ...f, id: '123-1', s3, tentativas: 2, esperar: async () => {} }), /SEM_RECIBO/);
  assert.equal(chamadas.length, 2);
});
function simular(f, { falharInstalacao, falharHttp, baselineRuim, bloquearRollback, mudarAntes, falharApi, falharApiApos, semApi } = {}) {
  const antes = { rotulo: 'hml-20261106T120000-bbbbbbb', commit: 'b'.repeat(40), instalado: true, integro: true, consistente: true, garantiaContraCorrida: true, anterior: null };
  const estado = { portal: { ...antes }, painel: { ...antes } }, eventos = [], leituras = {};
  const deps = {
    identificar: async c => { leituras[c] = (leituras[c] || 0) + 1; if (mudarAntes && c === 'portal' && leituras[c] === 2) estado[c].commit = 'c'.repeat(40); return { ...estado[c], ...(baselineRuim ? { integro: false } : {}) }; },
    verificar: async (c, s) => { eventos.push(`http:${c}:${s.commit[0]}`); return !(falharHttp === c && s.commit === f.commit); },
    verificarApi: async () => { eventos.push('http:api'); return !falharApi && !(falharApiApos && estado[falharApiApos].commit === f.commit); },
    instalar: async (c, op) => { eventos.push(`instalar:${c}`); assert.equal(op.releaseSha256Esperado, f.releaseSha256); assert.equal(op.exigirDurabilidade, true); if (falharInstalacao === c) throw new Error('injetada'); estado[c] = { ...antes, rotulo: f.rotulo, commit: f.commit, anterior: antes.rotulo }; },
    reverter: async c => { eventos.push(`reverter:${c}`); if (bloquearRollback) throw new Error('bloqueado'); estado[c] = { ...antes }; },
    registrar: async r => eventos.push(r.fase),
  };
  if (semApi) delete deps.verificarApi;
  return { deps, estado, eventos };
}
test('agente comprova baseline e HTTP antes de instalar, depois comprova ambos e conclui', async t => {
  const f = fixture(t), s = simular(f);
  assert.deepEqual(await aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: s.deps }), { estado: 'SUCESSO', verificado: true });
  assert.ok(s.eventos.indexOf('http:painel:b') < s.eventos.indexOf('instalar:portal'));
  assert.equal(s.estado.portal.commit, f.commit);
  assert.equal(s.estado.painel.commit, f.commit);
});
test('API é conferida uma vez por fase, fora da verificação por componente; sem ela nada é instalado', async t => {
  const f = fixture(t), s = simular(f);
  await aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: s.deps });
  assert.equal(s.eventos.filter(e => e === 'http:api').length, 4, 'pré, após cada componente e final');
  assert.ok(s.eventos.indexOf('http:api') > s.eventos.indexOf('http:painel:b') && s.eventos.indexOf('http:api') < s.eventos.indexOf('instalar:portal'));
  const pre = simular(f, { falharApi: true });
  await assert.rejects(aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: pre.deps }), /PRE_DEPLOY_HTTP/);
  assert.ok(!pre.eventos.some(e => e.startsWith('instalar:')));
  const sem = simular(f, { semApi: true });
  await assert.rejects(aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: sem.deps }), /DEPENDENCIAS_INCOMPLETAS/);
  assert.ok(!sem.eventos.some(e => e.startsWith('instalar:') || e.startsWith('http:')));
});
test('API indisponível depois da primeira troca recupera o componente alterado; a recuperação é comprovada pelas páginas', async t => {
  const f = fixture(t), s = simular(f, { falharApiApos: 'portal' });
  const r = await aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: s.deps });
  assert.equal(r.estado, 'FALHOU'); assert.equal(r.recuperacaoComprovada, true);
  assert.ok(s.eventos.includes('reverter:portal') && !s.eventos.includes('instalar:painel'));
  assert.equal(s.estado.portal.commit, 'b'.repeat(40));
});
test('falha no segundo componente ou no HTTP recupera apenas os componentes alterados', async t => {
  const f = fixture(t);
  for (const op of [{ falharInstalacao: 'painel' }, { falharHttp: 'painel' }, { falharHttp: 'portal' }]) {
    const s = simular(f, op);
    assert.equal((await aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: s.deps })).estado, 'FALHOU');
    assert.equal(s.estado.portal.commit, 'b'.repeat(40));
    assert.equal(s.estado.painel.commit, 'b'.repeat(40));
    assert.ok(s.eventos.includes('reverter:portal'));
    if (op.falharInstalacao) assert.ok(!s.eventos.includes('reverter:painel'));
  }
});
test('rollback bloqueado produz CRITICO; baseline corrompida impede qualquer instalação', async t => {
  const f = fixture(t), s = simular(f, { falharHttp: 'portal', bloquearRollback: true });
  assert.equal((await aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: s.deps })).estado, 'CRITICO');
  const ruim = simular(f, { baselineRuim: true });
  await assert.rejects(aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: ruim.deps }), /BASELINE/);
  assert.ok(!ruim.eventos.some(e => e.startsWith('instalar:')));
});
test('mudança concorrente de identidade é bloqueada e não reverte um terceiro commit', async t => {
  const f = fixture(t), s = simular(f, { mudarAntes: true });
  assert.equal((await aplicar({ pedido: pedido(f), releaseDir: f.dir, deps: s.deps })).estado, 'CRITICO');
  assert.ok(!s.eventos.some(e => e.startsWith('instalar:') || e.startsWith('reverter:')));
});
test('pedido expirado entre componentes recupera o primeiro sem instalar o segundo', async t => {
  const f = fixture(t), s = simular(f), p = pedido(f);
  let chamadas = 0;
  const r = await aplicar({ pedido: p, releaseDir: f.dir, deps: s.deps, agora: () => ++chamadas <= 3 ? Date.parse(p.criadoEm) : Date.parse(p.expiraEm) + 1 });
  assert.equal(r.estado, 'FALHOU');
  assert.ok(s.eventos.includes('instalar:portal'));
  assert.ok(!s.eventos.includes('instalar:painel'));
  assert.equal(s.estado.portal.commit, 'b'.repeat(40));
});
test('agente recusa configuração desligada, backend, raízes sobrepostas ou sem revisão', t => {
  const f = fixture(t), dirs = {};
  for (const c of ['portal', 'painel', 'estado', 'institucional']) { dirs[c] = path.join(f.dir, c + '-raiz'); fs.mkdirSync(dirs[c]); }
  const cfg = { habilitado: true, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_SEM_INSTITUCIONAL', raizesProtegidas: [dirs.institucional], estadoDir: dirs.estado, instalador: { raizesPersistentes: [], componentes: { portal: { tipo: 'estatico', nome: 'portal', base: dirs.portal }, painel: { tipo: 'estatico', nome: 'painel', base: dirs.painel } } }, urls: { portal: 'https://portal.example.test', painel: 'https://painel.example.test' } };
  assert.equal(validarConfiguracao(cfg), cfg);
  for (const extra of [{ habilitado: false }, { isolamentoRevisado: '' }, { raizesProtegidas: [] }, { raizesProtegidas: [dirs.portal] }, { estadoDir: dirs.portal }, { urls: { ...cfg.urls, portal: 'http://portal.example.test' } }, { instalador: { ...cfg.instalador, componentes: { ...cfg.instalador.componentes, backend: { tipo: 'backend', nome: 'backend', base: dirs.portal } } } }])
    assert.throws(() => validarConfiguracao({ ...cfg, ...extra }));
  const { origemDaApi } = require(path.join(raiz, 'deploy/hml/cd/agente'));
  assert.equal(origemDaApi(cfg), cfg.urls.portal, 'sem apiSaude a API é conferida na origem do Portal');
  for (const apiSaude of ['https://api.example.test', 'http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000']) {
    assert.deepEqual(validarConfiguracao({ ...cfg, apiSaude }), { ...cfg, apiSaude });
    assert.equal(origemDaApi({ ...cfg, apiSaude }), apiSaude);
  }
  for (const apiSaude of ['http://api.example.test', 'https://api.example.test/api', 'https://u:p@api.example.test', 'https://painel.example.test/', 'api.example.test', 42, null])
    assert.throws(() => validarConfiguracao({ ...cfg, apiSaude }), /API_SAUDE_INVALIDA/);
});
test('os pacotes reais dos empacotadores existentes atravessam o protocolo sem mudar arquivos', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-52-real-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saida = path.join(dir, 'release'), commit = 'a'.repeat(40), rotulo = 'hml-20261107T120000-aaaaaaa';
  require(path.join(raiz, '.github/scripts/hml/gerar-release')).gerarRelease({ saida, commit, rotulo, atual: true });
  const identidade = { commit, rotulo, releaseSha256: hash(fs.readFileSync(path.join(saida, 'release.json'))) };
  const b = protocolo.empacotar(saida, identidade), extraido = path.join(dir, 'extraido');
  protocolo.extrair(b, extraido);
  const r = protocolo.conferirRelease({ dir: extraido, ...identidade });
  assert.ok(r.release.portal.arquivos > 1 && r.release.painel.arquivos === 25);
  assert.deepEqual(protocolo.arquivos(extraido), protocolo.arquivos(saida));
});
