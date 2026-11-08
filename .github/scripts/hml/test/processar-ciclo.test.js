'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const raiz = path.resolve(__dirname, '../../../..');
const modulo = rel => require(path.join(raiz, rel));
const ancora = modulo('deploy/hml/instalador/ancora');
const N = modulo('deploy/hml/instalador/nucleo');
const I = modulo('deploy/hml/instalador/instalar-release');
const V = modulo('deploy/hml/verificacao/verificar-publicacao');
const P = modulo('deploy/hml/cd/protocolo');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const originais = { ancora: ancora.criarAncora, instalar: I.instalar, reverter: I.reverter, identificar: I.identificar, contexto: N.abrirContexto, meta: N.lerMeta, verificar: V.verificarPublicacao, env: process.env.NODE_ENV };
process.env.NODE_ENV = 'test';
let atual;
ancora.criarAncora = op => {
  const a = originais.ancora(process.platform === 'linux' ? op : { ...op, modo: 'caminho', semGarantiaDeCorrida: true });
  const escrever = a.escreverAtomico;
  a.escreverAtomico = (base, nome, texto) => {
    const r = JSON.parse(texto);
    if (atual.falharFase === r.fase) throw new Error('falha de gravação sintética');
    return escrever(base, nome, texto);
  };
  return a;
};
I.identificar = async ({ componente }) => ({ ...atual.estado[componente] });
I.instalar = async ({ componente, release }) => {
  atual.chamadas.push(`instalar:${componente}`);
  if (atual.falharInstalacao === componente) throw new Error('falha sintética');
  const r = JSON.parse(fs.readFileSync(path.join(release, 'release.json')));
  atual.estado[componente] = { ...atual.baseline, rotulo: r.rotulo, commit: r.commit, anterior: atual.baseline.rotulo };
};
I.reverter = async ({ componente }) => {
  atual.chamadas.push(`reverter:${componente}`);
  if (atual.falharRollback) throw new Error('recuperação recusada');
  atual.estado[componente] = { ...atual.baseline };
};
N.abrirContexto = (A, comp) => ({ comp });
N.lerMeta = ctx => ({ ...atual.estado[ctx.comp.nome], manifesto: { 'index.html': hash('sintético') }, manifestoSha256: hash('manifesto') });
V.verificarPublicacao = async ({ baseUrl }) => {
  const c = baseUrl.includes('portal') ? 'portal' : 'painel';
  return { ok: !atual.falharPre && !(atual.falharHttp === c && atual.estado[c].commit === atual.commit) };
};
const agente = modulo('deploy/hml/cd/agente');
after(() => {
  ancora.criarAncora = originais.ancora;
  Object.assign(I, { instalar: originais.instalar, reverter: originais.reverter, identificar: originais.identificar });
  Object.assign(N, { abrirContexto: originais.contexto, lerMeta: originais.meta });
  V.verificarPublicacao = originais.verificar;
  if (originais.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originais.env;
});
let sequencia = 100;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-53a-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const estadoDir = path.join(dir, 'estado'); fs.mkdirSync(estadoDir, { mode: 0o700 });
  const commit = 'a'.repeat(40), rotulo = 'hml-20261107T120000-aaaaaaa';
  const release = { commit, rotulo, atual: true, geradoEm: new Date().toISOString() };
  const origem = path.join(dir, 'release'); fs.mkdirSync(origem);
  for (const c of ['portal', 'painel']) {
    fs.mkdirSync(path.join(origem, c));
    fs.writeFileSync(path.join(origem, c, 'index.html'), c);
    const m = `${hash(c)}  index.html\n`;
    fs.writeFileSync(path.join(origem, `manifesto-${c}.sha256`), m);
    release[c] = { arquivos: 1, manifestoSha256: hash(m) };
  }
  fs.writeFileSync(path.join(origem, 'release.json'), JSON.stringify(release));
  const releaseSha256 = hash(fs.readFileSync(path.join(origem, 'release.json')));
  const blob = P.empacotar(origem, { commit, rotulo, releaseSha256 });
  const id = `${++sequencia}-1`, agora = Date.now();
  const pedido = { versao: 1, repositorio: P.REPO, id, commit, rotulo, releaseSha256, blobSha256: hash(blob), permitirAnterior: false, criadoEm: new Date(agora).toISOString(), expiraEm: new Date(agora + 480000).toISOString() };
  const objetos = new Map([[`hml/pedidos/${id}.json`, Buffer.from(JSON.stringify(pedido))], [`hml/blobs/${id}.json`, blob]]);
  const baseline = { instalado: true, integro: true, consistente: true, garantiaContraCorrida: true, commit: 'b'.repeat(40), rotulo: 'hml-20261106T120000-bbbbbbb', anterior: null };
  const cfg = { estadoDir, instalador: { raizesPersistentes: [], componentes: { portal: { tipo: 'estatico', nome: 'portal', base: path.join(dir, 'portal') }, painel: { tipo: 'estatico', nome: 'painel', base: path.join(dir, 'painel') } } }, urls: { portal: 'https://portal.example.test', painel: 'https://painel.example.test' } };
  const f = { dir, cfg, pedido, id, objetos, baseline, commit, chamadas: [], estado: { portal: { ...baseline }, painel: { ...baseline } } };
  f.s3 = { get: async k => { if (f.falharGet === k) throw Object.assign(new Error('transporte'), { codigo: 'S3_OPERACAO_FALHOU' }); return objetos.get(k) || null; }, put: async (k, b) => { if (f.falharPut) throw Object.assign(new Error('transporte'), { codigo: 'S3_OPERACAO_FALHOU' }); assert.ok(!objetos.has(k)); objetos.set(k, b); } };
  f.salvarPedido = () => objetos.set(`hml/pedidos/${id}.json`, Buffer.from(JSON.stringify(pedido)));
  f.processar = () => { atual = f; return agente.processar({ cfg, id, s3: f.s3 }); };
  f.registro = () => JSON.parse(fs.readFileSync(path.join(cfg.estadoDir, `${id}.json`)));
  f.trava = () => fs.existsSync(path.join(cfg.estadoDir, '.trava-cd'));
  return f;
}
test('pedido expirado registra RECUSADO, não instala e libera a trava', async t => {
  const f = fixture(t);
  f.pedido.criadoEm = new Date(Date.now() - 900000).toISOString();
  f.pedido.expiraEm = new Date(Date.now() - 420000).toISOString(); f.salvarPedido();
  const r = await f.processar();
  assert.equal(r.estado, 'RECUSADO'); assert.equal(f.registro().fase, 'TERMINAL');
  assert.equal(f.trava(), false); assert.deepEqual(f.chamadas, []);
});
test('falha de transporte antes da instalação deixa recusa local durável e fila livre', async t => {
  const f = fixture(t); f.falharGet = `hml/pedidos/${f.id}.json`;
  const r = await f.processar();
  assert.equal(r.estado, 'RECUSADO'); assert.equal(f.trava(), false);
  assert.equal(f.registro().resultado.mutacao, 'NENHUMA'); assert.deepEqual(f.chamadas, []);
});
test('blob adulterado é recusado sem trocar qualquer release', async t => {
  const f = fixture(t); f.objetos.set(`hml/blobs/${f.id}.json`, Buffer.from('adulterado'));
  assert.equal((await f.processar()).estado, 'RECUSADO');
  assert.equal(f.trava(), false); assert.deepEqual(f.chamadas, []);
});
test('pedido válido subsequente ao expirado é processado no mesmo diretório de estado', async t => {
  const rejeitado = fixture(t), valido = fixture(t);
  rejeitado.pedido.criadoEm = new Date(Date.now() - 900000).toISOString();
  rejeitado.pedido.expiraEm = new Date(Date.now() - 420000).toISOString(); rejeitado.salvarPedido();
  await rejeitado.processar();
  valido.cfg.estadoDir = rejeitado.cfg.estadoDir;
  assert.equal((await valido.processar()).estado, 'SUCESSO');
  assert.deepEqual(valido.chamadas, ['instalar:portal', 'instalar:painel']);
  assert.equal(valido.trava(), false);
});
test('falha da segunda instalação recupera o par e registra comprovação antes de liberar', async t => {
  const f = fixture(t); f.falharInstalacao = 'painel';
  const r = await f.processar();
  assert.equal(r.estado, 'FALHOU'); assert.equal(r.recuperacaoComprovada, true);
  assert.equal(f.trava(), false);
  assert.equal(f.registro().antes.portal.commit, f.baseline.commit);
  assert.deepEqual(f.estado, { portal: f.baseline, painel: f.baseline });
});
test('recuperação não comprovada mantém CRITICO e bloqueia pedido seguinte', async t => {
  const f = fixture(t); f.falharInstalacao = 'painel'; f.falharRollback = true;
  assert.equal((await f.processar()).estado, 'CRITICO');
  assert.equal(f.trava(), true); assert.equal(f.registro().resultado.estado, 'CRITICO');
  const seguinte = fixture(t); seguinte.cfg.estadoDir = f.cfg.estadoDir;
  await assert.rejects(seguinte.processar());
  assert.deepEqual(seguinte.chamadas, []); assert.equal(seguinte.trava(), true);
});
test('pré-deploy HTTP recusado não chama instalador e não bloqueia fila', async t => {
  const f = fixture(t); f.falharPre = true;
  assert.equal((await f.processar()).estado, 'RECUSADO');
  assert.deepEqual(f.chamadas, []); assert.equal(f.trava(), false);
});
test('falha de recibo preserva terminal local e reenvio não reinstala', async t => {
  const f = fixture(t); f.falharPut = true;
  const primeiro = await f.processar();
  assert.equal(primeiro.estado, 'SUCESSO'); assert.equal(primeiro.reciboPendente, true);
  assert.equal(f.trava(), false);
  const chamadas = [...f.chamadas]; f.falharPut = false;
  const segundo = await f.processar();
  assert.equal(segundo.estado, 'SUCESSO'); assert.equal(segundo.reciboPendente, undefined);
  assert.deepEqual(f.chamadas, chamadas);
  assert.ok(f.objetos.has(`hml/recibos/${f.id}.json`));
});
test('trava existente é preservada e nenhum registro é sobrescrito', async t => {
  const f = fixture(t), lock = path.join(f.cfg.estadoDir, '.trava-cd');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'preservar'), 'outro processo');
  await assert.rejects(f.processar());
  assert.equal(fs.readFileSync(path.join(lock, 'preservar'), 'utf8'), 'outro processo');
  assert.equal(fs.existsSync(path.join(f.cfg.estadoDir, `${f.id}.json`)), false);
});
test('registro não terminal e registro ilegível mantêm bloqueio', async t => {
  for (const conteudo of [JSON.stringify({ versao: 2, id: 'outro', fase: 'INSTALACAO_INICIADA' }), 'json ilegível']) {
    const f = fixture(t), arquivo = path.join(f.cfg.estadoDir, `${f.id}.json`);
    fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
    await assert.rejects(f.processar());
    assert.equal(fs.readFileSync(arquivo, 'utf8'), conteudo); assert.equal(f.trava(), true);
  }
});
test('falha no terminal durável conserva a trava mesmo em recusa sem mutação', async t => {
  const f = fixture(t); f.falharGet = `hml/pedidos/${f.id}.json`; f.falharFase = 'TERMINAL';
  await assert.rejects(f.processar());
  assert.equal(f.trava(), true); assert.equal(f.registro().fase, 'INICIO');
  assert.deepEqual(f.chamadas, []);
});
test('falha ao registrar início de instalação impede chamar instalador', async t => {
  const f = fixture(t); f.falharFase = 'INSTALACAO_INICIADA';
  const r = await f.processar();
  assert.equal(r.estado, 'FALHOU'); assert.equal(r.recuperacaoComprovada, true);
  assert.deepEqual(f.chamadas, []); assert.equal(f.trava(), false);
});
test('recibo conflitante vira estado crítico persistente e mantém trava', async t => {
  const f = fixture(t); f.objetos.set(`hml/recibos/${f.id}.json`, Buffer.from('outro recibo'));
  await assert.rejects(f.processar(), /RECIBO_DIVERGENTE/);
  assert.equal(f.trava(), true); assert.equal(f.registro().resultado.estado, 'CRITICO');
});
test('entrada preexistente de origem incerta é preservada e bloqueia', async t => {
  const f = fixture(t), dir = path.join(f.cfg.estadoDir, `entrada-${f.id}`);
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'preservar'), 'origem incerta');
  assert.equal((await f.processar()).estado, 'CRITICO');
  assert.equal(f.trava(), true); assert.deepEqual(f.chamadas, []);
  assert.equal(fs.readFileSync(path.join(dir, 'preservar'), 'utf8'), 'origem incerta');
});
test('scanner continua após recusa e retorna falha agregada sem ocultá-la', async t => {
  const antigo = fixture(t), valido = fixture(t);
  antigo.pedido.criadoEm = new Date(Date.now() - 900000).toISOString();
  antigo.pedido.expiraEm = new Date(Date.now() - 420000).toISOString(); antigo.salvarPedido();
  for (const [k, v] of antigo.objetos) valido.objetos.set(k, v);
  atual = valido;
  const r = await agente.processarFila({ cfg: valido.cfg, ids: [antigo.id, valido.id], s3: valido.s3 });
  assert.equal(r.ok, false); assert.deepEqual(valido.chamadas, ['instalar:portal', 'instalar:painel']);
  assert.equal(valido.trava(), false);
});
test('recibo RECUSADO nunca é aceito como publicação aprovada', t => {
  const f = fixture(t);
  assert.throws(() => P.validarRecibo({ id: f.id, commit: f.commit, releaseSha256: f.pedido.releaseSha256, estado: 'RECUSADO', verificado: false }, f.pedido), /DEPLOY_NAO_APROVADO/);
});
test('scanner interrompe passagem após instalação com recibo pendente e retoma só reenvio', async t => {
  const f = fixture(t), seguinte = fixture(t);
  for (const [k, v] of seguinte.objetos) f.objetos.set(k, v);
  atual = f; f.falharPut = true;
  assert.equal((await agente.processarFila({ cfg: f.cfg, ids: [f.id, seguinte.id], s3: f.s3 })).ok, false);
  assert.equal(f.chamadas.length, 2);
  assert.equal(fs.existsSync(path.join(f.cfg.estadoDir, `${seguinte.id}.json`)), false);
  f.falharPut = false;
  assert.equal((await agente.processarFila({ cfg: f.cfg, ids: [f.id, seguinte.id], s3: f.s3 })).ok, true);
  assert.equal(f.chamadas.length, 4);
});
test('scanner continua após recusa local sem identidade remota e não refaz o pedido recusado', async t => {
  const f = fixture(t), seguinte = fixture(t);
  for (const [k, v] of seguinte.objetos) f.objetos.set(k, v);
  atual = f; f.falharGet = `hml/pedidos/${f.id}.json`;
  assert.equal((await agente.processarFila({ cfg: f.cfg, ids: [f.id, seguinte.id], s3: f.s3 })).ok, false);
  assert.equal(f.registro().resultado.estado, 'RECUSADO');
  assert.equal(f.chamadas.length, 2); assert.equal(f.trava(), false);
});
