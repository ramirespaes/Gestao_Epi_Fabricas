'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const M = require('../../src/services/backup-fontes-manifesto-l2.service');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { verificarPacoteL2 } = require('../../src/services/backup-fontes-composicao-l2.service');
const { obterCatalogo } = require('../../src/services/backup-fontes-catalogo.service');

/** D-ORF-6, P11 — cifra em envelope de um pacote L2 verificado e decifra para pacote reconstruído; chaves SINTÉTICAS em memória (TESTE_CONTROLADO). */

const raizes = [];
after(() => { for (const r of raizes) fs.rmSync(r, { recursive: true, force: true }); });
const novaRaiz = () => { const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-p11-')); fs.chmodSync(r, 0o700); raizes.push(r); return r; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SEG_MAC = crypto.randomBytes(32);
const SEG_KEK = crypto.randomBytes(32);
const fonteMac = (extra = {}) => H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-1', segredo: SEG_MAC, ...extra }] });
const fonteCifra = (extra = {}) => E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-1', segredo: SEG_KEK, ...extra }] });
const chaves = () => ({ cifra: { fonte: fonteCifra(), chaveId: 'kek-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } });

/** Pacote L2 sintético em disco: 2 imagens padrão, dump e manifesto selado pelo escritor L2. */
function pacoteSintetico(raiz) {
  const dir = path.join(raiz, 'pacote');
  fs.mkdirSync(dir, { mode: 0o700 });
  const mestre = Buffer.from(`mestre-${raiz}`);
  const mini = Buffer.from('mini');
  const h = sha(mestre);
  for (const [chave, b] of [[`padrao/${h}/mestre.png`, mestre], [`padrao/${h}/miniatura.webp`, mini]]) {
    fs.mkdirSync(path.join(dir, 'arquivos', 'imagens', 'padrao', h), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'arquivos', 'imagens', ...chave.split('/')), b, { mode: 0o600 });
  }
  fs.mkdirSync(path.join(dir, 'dump'), { mode: 0o700 });
  const dump = Buffer.from('PGDMP-ficticio-p11');
  fs.writeFileSync(path.join(dir, 'dump', 'postgres.dump'), dump, { mode: 0o600 });
  const escrito = M.criarEscritorL2({ fonteDeChaves: fonteMac(), chaveId: 'mac-1' }).construir({
    banco: { nome: 'gepi_p11', oid: '16384' }, conjuntoId: 'conjunto-p11', dump: { bytes: dump.length, sha256: sha(dump) }, catalogo: obterCatalogo(),
    fontes: [{ id: 'imagens', arquivos: [{ chave: `padrao/${h}/mestre.png`, sha256: h, bytes: mestre.length }, { chave: `padrao/${h}/miniatura.webp`, sha256: sha(mini), bytes: mini.length }] }],
    contexto: {}, postgres: C.blocoN0(),
  });
  fs.writeFileSync(path.join(dir, 'manifesto.json'), escrito.bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'manifesto.sha256'), `${escrito.sha256}  manifesto.json\n`, { mode: 0o600 });
  return { dir, lido: escrito, mestre, h };
}
const arvore = (dir) => { const out = []; const anda = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) anda(r); else out.push(r); } }; anda(''); return out.sort(); };

describe('[CE] fonte de cifra e separação de chaves (RC-4, D-F5)', () => {
  test('CE-01 — fonte de cifra: só TESTE_CONTROLADO, 32 bytes exatos, ids únicos; a fonte operacional é BLOQUEADA (lista vazia); fontes de famílias diferentes não se confundem', () => {
    const f = fonteCifra();
    assert.equal(E.ehFonteDeCifra(f), true);
    assert.equal(E.ehFonteDeCifra(fonteMac()), false);
    assert.equal(H.ehFonteDeChaves(f), false, 'uma fonte de cifra nunca é aceita como fonte do manifesto');
    assert.equal(f.obter('kek-1').situacao, 'ATIVA');
    assert.equal(f.obter('x').situacao, 'INDISPONIVEL');
    assert.ok(!JSON.stringify(f).includes(SEG_KEK.toString('hex')));
    assert.throws(() => E.criarFonteDeChavesDeCifra({ origem: 'OPERACIONAL', chaves: [{ id: 'a', segredo: SEG_KEK }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'a', segredo: crypto.randomBytes(16) }] }), (e) => e.code === 'FONTE_INVALIDA');
    assert.throws(() => E.criarFonteOperacionalDeCifra({ provedor: 'kms', adaptador: {} }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
    assert.deepEqual(E.PROVEDORES_DE_CIFRA_APROVADOS, []);
  });

  test('CE-02 — capturarChaves recusa: mesma fonte, mesma família, mesmo id, mesmo segredo, revogada, indisponível; aceita fontes separadas', () => {
    const ok = E.capturarChaves(chaves());
    assert.equal(ok.motivo, undefined);
    assert.equal(ok.kek.length, 32);
    const mesmoSegredo = { cifra: { fonte: E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k', segredo: SEG_MAC }] }), chaveId: 'k' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } };
    assert.equal(E.capturarChaves(mesmoSegredo).motivo, 'CHAVES_NAO_SEPARADAS');
    assert.equal(E.capturarChaves({ cifra: { fonte: fonteMac(), chaveId: 'mac-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } }).motivo, 'CHAVES_NAO_SEPARADAS');
    assert.equal(E.capturarChaves({ cifra: { fonte: fonteCifra(), chaveId: 'mac-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } }).motivo, 'CHAVES_NAO_SEPARADAS');
    assert.equal(E.capturarChaves({ cifra: { fonte: fonteCifra({ revogada: true }), chaveId: 'kek-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } }).motivo, 'CHAVE_DE_CIFRA_REVOGADA');
    assert.equal(E.capturarChaves({ cifra: { fonte: fonteCifra(), chaveId: 'kek-9' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } }).motivo, 'CHAVE_DE_CIFRA_INDISPONIVEL');
    assert.equal(E.capturarChaves({ cifra: { fonte: fonteCifra(), chaveId: 'kek-1' }, mac: { fonte: fonteMac({ revogada: true }), chaveId: 'mac-1' } }).motivo, 'CHAVE_DE_MAC_REVOGADA');
  });
});

describe('[CP11] cifrar e decifrar pacote L2', () => {
  test('CP11-01 — ida e volta: contêiner com envelope autenticado e dados/*.enc; nenhum byte em claro no contêiner; decifra para pacote NOVO idêntico e verificável pelo leitor L2', async () => {
    const raiz = novaRaiz();
    const p = pacoteSintetico(raiz);
    const container = path.join(raiz, 'cifrado');
    const r = await E.cifrarPacote({ pacote: p.dir, lido: p.lido, destino: container, ...chaves() });
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.deepEqual([r.arquivos, r.chaveIdCifra, r.chaveIdMac], [5, 'kek-1', 'mac-1']);
    const lista = arvore(container);
    assert.ok(lista.includes('envelope.json') && lista.every((f) => f === 'envelope.json' || f.startsWith('dados/')) && lista.every((f) => f === 'envelope.json' || f.endsWith('.enc')), lista.join(','));
    assert.equal(lista.length, 6);
    // nenhum conteúdo em claro: nem o mestre, nem o dump, nem o manifesto
    for (const f of lista.filter((x) => x !== 'envelope.json')) { const b = fs.readFileSync(path.join(container, f)); assert.ok(!b.includes(p.mestre) && !b.includes('PGDMP') && !b.includes('"versao":2'), f); }
    const envelope = JSON.parse(fs.readFileSync(path.join(container, 'envelope.json'), 'utf8'));
    assert.deepEqual(Object.keys(envelope), [...E.CHAVES_DO_ENVELOPE]);
    assert.equal(envelope.algoritmo, 'AES-256-GCM');
    assert.equal(envelope.autenticacao.chaveId, 'mac-1');
    assert.ok(!JSON.stringify(envelope).includes(SEG_KEK.toString('hex')) && !JSON.stringify(envelope).includes(SEG_MAC.toString('hex')));
    assert.ok(envelope.arquivos.every((a) => typeof a.caminho === 'string' && !a.caminho.includes(raiz)), 'caminhos relativos apenas');
    const reconstruido = path.join(raiz, 'reconstruido');
    const d = await E.decifrarContainer({ container, destino: reconstruido, ...chaves() });
    assert.equal(d.ok, true, JSON.stringify(d.falha));
    assert.deepEqual(arvore(reconstruido), arvore(p.dir));
    for (const f of arvore(p.dir)) assert.ok(fs.readFileSync(path.join(reconstruido, f)).equals(fs.readFileSync(path.join(p.dir, f))), f);
    const leitor = M.criarLeitorL2({ fonteDeChaves: fonteMac(), layoutMinimo: 2 });
    const bytes = fs.readFileSync(path.join(reconstruido, 'manifesto.json'));
    const lido = leitor({ bytes, sha256: sha(bytes) });
    assert.deepEqual(await verificarPacoteL2({ pacote: reconstruido, lido }), { ok: true, arquivos: 5, sha256Manifesto: lido.identidade.sha256Manifesto, layout: 2 });
    // destino existente: recusa sem tocar
    assert.deepEqual((await E.decifrarContainer({ container, destino: reconstruido, ...chaves() })).falha, { passo: 'DESTINO', codigo: 'DESTINO_EXISTENTE' });
    assert.deepEqual((await E.cifrarPacote({ pacote: p.dir, lido: p.lido, destino: container, ...chaves() })).falha, { passo: 'DESTINO', codigo: 'DESTINO_EXISTENTE' });
  });

  test('CP11-02 — falha fechada na decifra: envelope adulterado (MAC), chave de cifra errada (DEK não desenvolvida), arquivo cifrado adulterado (tag GCM), arquivo ausente, chave divergente, envelope com campo extra; nada é publicado no destino', async () => {
    const raiz = novaRaiz();
    const p = pacoteSintetico(raiz);
    const container = path.join(raiz, 'cifrado');
    assert.equal((await E.cifrarPacote({ pacote: p.dir, lido: p.lido, destino: container, ...chaves() })).ok, true);
    const envelopeBytes = fs.readFileSync(path.join(container, 'envelope.json'));
    const clonar = (nome, alterar) => {
      const c = path.join(raiz, nome);
      fs.cpSync(container, c, { recursive: true });
      alterar(c);
      return c;
    };
    const destinoDe = (n) => path.join(raiz, `d-${n}`);
    // envelope adulterado: um byte do campo bytes
    const c1 = clonar('c1', (c) => { const o = JSON.parse(envelopeBytes.toString()); o.arquivos[0].bytes += 1; fs.writeFileSync(path.join(c, 'envelope.json'), JSON.stringify(o)); });
    assert.deepEqual((await E.decifrarContainer({ container: c1, destino: destinoDe(1), ...chaves() })).falha, { passo: 'ENVELOPE', codigo: 'MAC_INVALIDO' });
    assert.ok(!fs.existsSync(destinoDe(1)));
    // chave de cifra errada (mesmo id, segredo diferente): MAC ok, DEK não desenvolve
    const outraKek = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-1', segredo: crypto.randomBytes(32) }] });
    assert.deepEqual((await E.decifrarContainer({ container, destino: destinoDe(2), cifra: { fonte: outraKek, chaveId: 'kek-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } })).falha, { passo: 'CHAVES', codigo: 'DEK_NAO_DESENVOLVIDA' });
    // arquivo cifrado adulterado: tag GCM falha, nada ligado ao destino
    const c3 = clonar('c3', (c) => { const f = path.join(c, 'dados', 'dump', 'postgres.dump.enc'); const b = fs.readFileSync(f); b[0] ^= 0xff; fs.writeFileSync(f, b); });
    const r3 = await E.decifrarContainer({ container: c3, destino: destinoDe(3), ...chaves() });
    assert.deepEqual(r3.falha, { passo: 'DECIFRA', codigo: 'ARQUIVO_ADULTERADO' });
    assert.ok(!fs.existsSync(path.join(destinoDe(3), 'dump', 'postgres.dump')), 'o arquivo adulterado nunca é publicado');
    // arquivo ausente
    const c4 = clonar('c4', (c) => fs.rmSync(path.join(c, 'dados', 'manifesto.sha256.enc')));
    assert.deepEqual((await E.decifrarContainer({ container: c4, destino: destinoDe(4), ...chaves() })).falha, { passo: 'DECIFRA', codigo: 'ARQUIVO_AUSENTE' });
    // chave de cifra divergente do envelope
    const kek2 = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-2', segredo: crypto.randomBytes(32) }] });
    assert.deepEqual((await E.decifrarContainer({ container, destino: destinoDe(5), cifra: { fonte: kek2, chaveId: 'kek-2' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } })).falha, { passo: 'CHAVES', codigo: 'CHAVE_DE_CIFRA_DIVERGENTE' });
    // campo extra no envelope assinado de novo com a chave certa: forma exata recusa
    const c6 = clonar('c6', (c) => { const o = JSON.parse(envelopeBytes.toString()); o.extra = 1; fs.writeFileSync(path.join(c, 'envelope.json'), JSON.stringify(o)); });
    assert.equal((await E.decifrarContainer({ container: c6, destino: destinoDe(6), ...chaves() })).falha.passo, 'ENVELOPE');
    // chave MAC revogada: nada é lido além do envelope
    assert.deepEqual((await E.decifrarContainer({ container, destino: destinoDe(7), cifra: { fonte: fonteCifra(), chaveId: 'kek-1' }, mac: { fonte: fonteMac({ revogada: true }), chaveId: 'mac-1' } })).falha, { passo: 'CHAVES', codigo: 'CHAVE_DE_MAC_REVOGADA' });
  });

  test('CP11-03 — cifrar exige pacote verificado: arquivo extra ou divergente no pacote recusa antes de criar o contêiner; chaves não separadas recusam antes de ler o pacote', async () => {
    const raiz = novaRaiz();
    const p = pacoteSintetico(raiz);
    fs.writeFileSync(path.join(p.dir, 'arquivos', 'extra.bin'), 'x');
    const r = await E.cifrarPacote({ pacote: p.dir, lido: p.lido, destino: path.join(raiz, 'c'), ...chaves() });
    assert.deepEqual(r.falha, { passo: 'VERIFICACAO', codigo: 'ARQUIVO_EXTRA' });
    assert.ok(!fs.existsSync(path.join(raiz, 'c')));
    fs.rmSync(path.join(p.dir, 'arquivos', 'extra.bin'));
    const naoSeparadas = await E.cifrarPacote({ pacote: p.dir, lido: p.lido, destino: path.join(raiz, 'c2'), cifra: { fonte: fonteMac(), chaveId: 'mac-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } });
    assert.deepEqual(naoSeparadas.falha, { passo: 'CHAVES', codigo: 'CHAVES_NAO_SEPARADAS' });
    assert.equal(E.validarEnvelope({ versao: 1 }), 'ENVELOPE_INVALIDO');
  });
});
