'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../../src/services/backup-baixador-duravel.service');
const Rb = require('../../src/services/backup-recibo-duravel.service');
const { criarValidadorDeDestinos } = require('../../src/services/imagem-backup-destinos.service');
const { ambienteS3 } = require('../helpers/ambiente-s3-falso');
const { arvore } = require('../helpers/pacote-l2-sintetico');

/**
 * R-D45 [DWN]: baixador de restauração POR VERSÃO EXPLÍCITA, agora VINCULADO ao registro oficial de destinos locais (`DESTINOS_AUTORIZADOS`, aqui um registro de TESTE do
 * mesmo validador): só cria um diretório NOVO, filho direto de uma raiz autorizada; revalida a contenção durante a operação; confere espaço e limites antes de gravar.
 * Cliente S3 falso; dados sintéticos.
 */

const raiz = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-dwn-'));
fs.chmodSync(raiz, 0o700);
after(() => fs.rmSync(raiz, { recursive: true, force: true }));
let n = 0;
const ARQUIVOS = [
  { chave: 'envelope.json', conteudo: Buffer.from('{"envelope":true}') },
  { chave: 'dados/a.enc', conteudo: crypto.randomBytes(3000) },
  { chave: 'dados/sub/b.enc', conteudo: crypto.randomBytes(10) },
];
const TOTAL = ARQUIVOS.reduce((s, a) => s + a.conteudo.length, 0);
const MARGEM = 64 * 1024 * 1024;

/** Cenário completo: conjunto publicado no S3 falso, destino local autorizado novo (e uma pasta `fora` que NUNCA pode receber nada) e o baixador. */
async function cenario({ ambiente, baixador = {}, bloco = 700 } = {}) {
  n += 1;
  const pai = path.join(raiz, `t${n}`);
  fs.mkdirSync(pai, { mode: 0o700 });
  const a = ambienteS3({ ambiente, bloco });
  const c = await a.publicar({ arquivos: ARQUIVOS, raiz: pai });
  assert.equal(c.ok, true);
  const dl = a.destinoLocal(pai);
  const fora = path.join(pai, 'fora');
  fs.mkdirSync(fora, { mode: 0o700 });
  const pedido = (extra = {}) => ({ consolidado: c.consolidado, destinoLocalId: dl.id, raiz: dl.raiz, nome: 'cont', ...extra });
  const lidos = () => a.s3.chamadas.filter((x) => x.operacao === 'lerVersao').length;
  return { a, c, dl, pai, fora, pedido, lidos, b: a.baixador(dl, baixador), novo: (o = {}) => a.baixador(dl, { ...baixador, ...o }) };
}
const semTemporarios = (dir) => assert.deepEqual(arvore(dir).filter((f) => f.endsWith('.tmp')), []);
const falha = (r, passo, codigo) => assert.deepEqual({ ok: r.ok, falha: r.falha }, { ok: false, falha: { passo, codigo } });
const modo = (c) => fs.statSync(c).mode & 0o777;
const nada = (x) => assert.deepEqual([fs.readdirSync(x.dl.raiz), fs.readdirSync(x.fora), x.lidos()], [[], [], 0], 'nada criado e nada lido');
/** Cliente de restauração que executa `acao` no primeiro objeto lido (`quando: 'leitura'`) ou depois do primeiro bloco do fluxo (`quando: 'fluxo'`). */
function comAcao(x, quando, acao) {
  const base = x.a.s3.clientes.restauracao;
  let feito = false;
  return {
    ...base,
    async lerVersao(p) {
      if (quando === 'leitura' && !feito) { feito = true; acao(); }
      const r = await base.lerVersao(p);
      if (quando !== 'fluxo') return r;
      return { bytes: r.bytes, fluxo: (async function* seguir() { let i = 0; for await (const b of r.fluxo) { yield b; i += 1; if (i === 1 && !feito) { feito = true; acao(); } } }()) };
    },
  };
}
const statfsCom = (livre, extra = {}) => async () => ({ bsize: 1, bavail: livre, files: 10_000_000, ffree: 10_000_000, ...extra });

describe('[DWN] baixar por versão explícita para um destino local autorizado', () => {
  test('DWN-01 — baixa o conjunto completo como filho NOVO da raiz autorizada: conteúdo igual, diretórios 0700, arquivos 0600, nenhum temporário, contagens e origem do destino', async () => {
    const x = await cenario();
    const r = await x.b.baixar(x.pedido());
    assert.deepEqual({ ok: r.ok, arquivos: r.arquivos, bytes: r.bytes, origemDoDestino: r.origemDoDestino, destino: r.destino }, { ok: true, arquivos: 3, bytes: TOTAL, origemDoDestino: 'TESTE_CONTROLADO', destino: path.join(x.dl.raiz, 'cont') });
    for (const f of ARQUIVOS) assert.ok(fs.readFileSync(path.join(r.destino, ...f.chave.split('/'))).equals(f.conteudo), f.chave);
    assert.deepEqual(arvore(r.destino), ['dados/a.enc', 'dados/sub/b.enc', 'envelope.json']);
    assert.deepEqual(fs.readdirSync(x.dl.raiz), ['cont']);
    for (const d of ['', 'dados', 'dados/sub']) assert.equal(modo(path.join(r.destino, d)), 0o700, d);
    for (const f of arvore(r.destino)) assert.equal(modo(path.join(r.destino, f)), 0o600, f);
    semTemporarios(r.destino);
    assert.deepEqual(fs.readdirSync(x.fora), []);
  });

  test('DWN-02 — lê SEMPRE a versão do recibo: uma versão forjada, mais nova sob o mesmo nome, nunca é baixada', async () => {
    const x = await cenario();
    x.a.s3.injetarVersaoExtra('hml/c1/dados/a.enc', Buffer.from('conteudo forjado'));
    const visto = [];
    const cliente = { ...x.a.s3.clientes.restauracao, async lerVersao(p) { visto.push(`${p.chave}@${p.versaoId}`); return x.a.s3.clientes.restauracao.lerVersao(p); } };
    const r = await x.novo({ cliente }).baixar(x.pedido());
    assert.equal(r.ok, true);
    assert.ok(fs.readFileSync(path.join(r.destino, 'dados', 'a.enc')).equals(ARQUIVOS[1].conteudo));
    assert.deepEqual(visto.sort(), x.c.consolidado.recibos.map((y) => `${y.chave}@${y.versaoId}`).sort());
  });

  test('DWN-03 — objeto diferente do recibo (mesmo tamanho, menor, maior) falha por INTEGRIDADE antes de publicar o arquivo; só o temporário próprio some', async () => {
    for (const novo of [(b) => crypto.randomBytes(b.length), (b) => b.subarray(0, b.length - 1), (b) => Buffer.concat([b, Buffer.from('+')])]) {
      const x = await cenario();
      x.a.s3.corromper('hml/c1/dados/a.enc', x.a.s3.versoes('hml/c1/dados/a.enc')[0].versaoId, novo(ARQUIVOS[1].conteudo));
      falha(await x.b.baixar(x.pedido()), 'BAIXAR', 'INTEGRIDADE_DIVERGENTE');
      const destino = path.join(x.dl.raiz, 'cont');
      assert.equal(fs.existsSync(path.join(destino, 'dados', 'a.enc')), false, 'o arquivo adulterado nunca é publicado');
      semTemporarios(destino);
      assert.deepEqual(fs.readdirSync(x.fora), []);
    }
  });
});

describe('[DWN] só grava em destinos locais AUTORIZADOS (registro oficial)', () => {
  test('DWN-04 — destino fora da lista: id desconhecido, raiz diferente da autorizada, registro vazio e a lista REAL (vazia) são recusados sem criar nada nem ler o bucket; validador de outro ambiente é recusado na criação', async () => {
    const x = await cenario();
    falha(await x.b.baixar(x.pedido({ destinoLocalId: 'nao-listado' })), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    const outra = path.join(x.pai, 'outra');
    fs.mkdirSync(outra, { mode: 0o700 });
    falha(await x.b.baixar(x.pedido({ raiz: outra })), 'DESTINO', 'RAIZ_DIFERENTE_DA_AUTORIZADA');
    const vazio = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [], PRODUCAO: [] } });
    const real = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO' });
    for (const validadorDeDestinos of [vazio, real]) falha(await x.novo({ validadorDeDestinos }).baixar(x.pedido()), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    nada(x);
    assert.deepEqual(fs.readdirSync(outra), []);
    const producao = criarValidadorDeDestinos({ ambiente: 'PRODUCAO', registro: { HOMOLOGACAO: [], PRODUCAO: [] } });
    assert.throws(() => x.novo({ validadorDeDestinos: producao }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  test('DWN-05 — destino protegido: raiz igual, acima ou abaixo de uma área protegida; raiz com permissão excessiva, identidade trocada, link, caminho com link ou inexistente', async () => {
    const x = await cenario();
    for (const protegido of [x.dl.raiz, path.dirname(x.dl.raiz), path.join(x.dl.raiz, 'inexistente')]) {
      falha(await x.novo({ protegidos: [protegido] }).baixar(x.pedido()), 'DESTINO', 'DESTINO_PROTEGIDO');
    }
    nada(x);
    assert.equal((await x.novo({ protegidos: [x.fora] }).baixar(x.pedido())).ok, true, 'área protegida sem relação com a raiz não atrapalha');

    const y = await cenario();
    fs.chmodSync(y.dl.raiz, 0o755);
    falha(await y.b.baixar(y.pedido()), 'DESTINO', 'PERMISSAO_EXCESSIVA');
    fs.chmodSync(y.dl.raiz, 0o700);
    const trocada = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [{ id: y.dl.id, raiz: y.dl.raiz, identidade: { dev: y.dl.identidade.dev, ino: y.dl.identidade.ino + 1 } }], PRODUCAO: [] } });
    falha(await y.novo({ validadorDeDestinos: trocada }).baixar(y.pedido()), 'DESTINO', 'IDENTIDADE_DIVERGENTE');
    const elo = path.join(y.pai, 'elo');
    fs.symlinkSync(y.dl.raiz, elo);
    const stElo = fs.lstatSync(elo);
    const viaElo = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [{ id: 'elo', raiz: elo, identidade: { dev: stElo.dev, ino: stElo.ino } }], PRODUCAO: [] } });
    falha(await y.novo({ validadorDeDestinos: viaElo }).baixar(y.pedido({ destinoLocalId: 'elo', raiz: elo })), 'DESTINO', 'LINK_SIMBOLICO');
    const real = path.join(y.pai, 'real');
    fs.mkdirSync(path.join(real, 'sub'), { recursive: true, mode: 0o700 });
    const ponte = path.join(y.pai, 'ponte');
    fs.symlinkSync(real, ponte);
    const atravesDoLink = path.join(ponte, 'sub');
    const stSub = fs.lstatSync(atravesDoLink);
    const noCaminho = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [{ id: 'ponte', raiz: atravesDoLink, identidade: { dev: stSub.dev, ino: stSub.ino } }], PRODUCAO: [] } });
    falha(await y.novo({ validadorDeDestinos: noCaminho }).baixar(y.pedido({ destinoLocalId: 'ponte', raiz: atravesDoLink })), 'DESTINO', 'LINK_SIMBOLICO_NO_CAMINHO');
    const ausente = path.join(y.pai, 'ausente');
    const inexistente = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', registro: { HOMOLOGACAO: [{ id: 'ausente', raiz: ausente, identidade: { dev: 1, ino: 1 } }], PRODUCAO: [] } });
    falha(await y.novo({ validadorDeDestinos: inexistente }).baixar(y.pedido({ destinoLocalId: 'ausente', raiz: ausente })), 'DESTINO', 'DESTINO_INACESSIVEL');
    assert.deepEqual([fs.readdirSync(y.dl.raiz), fs.readdirSync(real.concat('/sub')), y.lidos()], [[], [], 0]);
  });

  test('DWN-06 — validador forjado (token literal, exceção, motivo inventado) nunca autoriza: só o token produzido pelo validador oficial vale', async () => {
    const x = await cenario();
    const forjado = (validar) => ({ ambiente: 'HOMOLOGACAO', origem: 'OPERACIONAL', validar });
    const literal = forjado(() => ({ autorizado: true, motivo: null, destinoId: x.dl.id, ambiente: 'HOMOLOGACAO', origem: 'OPERACIONAL', raiz: x.dl.raiz }));
    falha(await x.novo({ validadorDeDestinos: literal }).baixar(x.pedido()), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    falha(await x.novo({ validadorDeDestinos: forjado(() => { throw new Error('detalhe-interno-secreto'); }) }).baixar(x.pedido()), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    const inventado = await x.novo({ validadorDeDestinos: forjado(() => ({ autorizado: false, motivo: 'qualquer texto livre <script>' })) }).baixar(x.pedido());
    falha(inventado, 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    assert.equal(JSON.stringify(inventado).includes('script'), false);
    nada(x);
    for (const ruim of [null, {}, { ambiente: 'HOMOLOGACAO' }, { ambiente: 'HOMOLOGACAO', validar: 1 }]) assert.throws(() => x.novo({ validadorDeDestinos: ruim }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});

describe('[DWN] contenção DURANTE a operação (componentes trocados, colisões)', () => {
  test('DWN-07 — troca concorrente: subpasta, destino ou raiz autorizada trocados por link ou por outra pasta entre as etapas; a operação para sem escrever fora e sem seguir o link', async () => {
    const trocas = {
      'subpasta vira link para fora': (x) => () => { const d = path.join(x.dl.raiz, 'cont', 'dados'); fs.renameSync(d, `${d}.orig`); fs.symlinkSync(x.fora, d); },
      'subpasta vira outra pasta real': (x) => () => { const d = path.join(x.dl.raiz, 'cont', 'dados'); fs.renameSync(d, `${d}.orig`); fs.mkdirSync(d, { mode: 0o700 }); },
      'destino vira link para fora': (x) => () => { const d = path.join(x.dl.raiz, 'cont'); fs.renameSync(d, `${d}.orig`); fs.symlinkSync(x.fora, d); },
      'raiz autorizada vira outra pasta': (x) => () => { fs.renameSync(x.dl.raiz, `${x.dl.raiz}.orig`); fs.mkdirSync(x.dl.raiz, { mode: 0o700 }); },
      'raiz autorizada ganha acesso de grupo e outros (modo 0755)': (x) => () => fs.chmodSync(x.dl.raiz, 0o755),
    };
    for (const quando of ['leitura', 'fluxo']) {
      for (const [nome, fazer] of Object.entries(trocas)) {
        const x = await cenario();
        const cliente = comAcao(x, quando, fazer(x));
        falha(await x.novo({ cliente }).baixar(x.pedido()), 'BAIXAR', 'DESTINO_ALTERADO');
        assert.deepEqual(fs.readdirSync(x.fora), [], `${nome} (${quando}): nada pode chegar ao destino do link`);
        if (nome === 'raiz autorizada vira outra pasta') assert.deepEqual(fs.readdirSync(x.dl.raiz), [], `${nome} (${quando}): a pasta nova não recebe nada`);
        if (nome === 'subpasta vira outra pasta real') assert.deepEqual(fs.readdirSync(path.join(x.dl.raiz, 'cont', 'dados')), [], `${nome} (${quando})`);
      }
    }
  });

  test('DWN-19 — temporário com nome já ocupado por um arquivo alheio (colisão forçada): O_EXCL recusa, o arquivo alheio NÃO é sobrescrito nem removido e nada é publicado', async () => {
    const x = await cenario();
    const alheio = path.join(x.dl.raiz, 'cont', 'dados', 'a.enc.0102030405060708.tmp');
    const cliente = comAcao(x, 'leitura', () => fs.writeFileSync(alheio, 'conteudo-alheio', { mode: 0o600 }));
    const original = crypto.randomBytes;
    crypto.randomBytes = (tamanho, ...resto) => (tamanho === 8 ? Buffer.from('0102030405060708', 'hex') : original(tamanho, ...resto));
    try { falha(await x.novo({ cliente }).baixar(x.pedido()), 'BAIXAR', 'ESCRITA_FALHOU'); } finally { crypto.randomBytes = original; }
    assert.equal(fs.readFileSync(alheio, 'utf8'), 'conteudo-alheio');
    assert.equal(fs.existsSync(path.join(x.dl.raiz, 'cont', 'dados', 'a.enc')), false);
    assert.deepEqual(fs.readdirSync(x.fora), []);
  });

  test('DWN-20 — depois do link, o arquivo publicado tem de ser o MESMO i-node do temporário: substituição logo após o link é detectada', async () => {
    const x = await cenario();
    const promessas = require('node:fs/promises');
    const original = promessas.link;
    promessas.link = async (de, para) => { await original(de, para); fs.rmSync(para); fs.writeFileSync(para, 'substituido', { mode: 0o600 }); };
    try { falha(await x.b.baixar(x.pedido()), 'BAIXAR', 'DESTINO_ALTERADO'); } finally { promessas.link = original; }
  });

  test('DWN-21 — ENOSPC durante a gravação (1º bloco, meio do arquivo, fsync e link): falha fechada com ESPACO_INSUFICIENTE, nenhum download seguinte, arquivo final não publicado, só o temporário PRÓPRIO removido; arquivos alheios e já publicados intactos', async () => {
    const promessas = require('node:fs/promises');
    const enospc = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
    const variantes = [
      { nome: '1º bloco do 2º arquivo', alvo: 2, tipo: 'escrita', apos: 0, lidos: 2 },
      { nome: 'meio do 1º arquivo', alvo: 1, tipo: 'escrita', apos: 2, lidos: 1 },
      { nome: 'fsync do 2º arquivo', alvo: 2, tipo: 'sync', lidos: 2 },
      { nome: 'link do 2º arquivo', alvo: 2, tipo: 'link', lidos: 2 },
    ];
    for (const v of variantes) {
      const x = await cenario();
      const destino = path.join(x.dl.raiz, 'cont');
      const dados = path.join(destino, 'dados');
      const alheios = { 'alheio.tmp': 'alheio-1', 'b.enc.ffffffffffffffff.tmp': 'alheio-2', 'a.enc.ffffffffffffffff.tmp': 'alheio-3' };
      const cliente = comAcao(x, 'leitura', () => { for (const [nome, conteudo] of Object.entries(alheios)) fs.writeFileSync(path.join(dados, nome), conteudo, { mode: 0o600 }); });
      const abrir = promessas.open;
      const ligar = promessas.link;
      let temporarios = 0;
      let ligacoes = 0;
      promessas.open = async (caminho, ...resto) => {
        const fh = await abrir(caminho, ...resto);
        if (!String(caminho).startsWith(destino) || !String(caminho).endsWith('.tmp')) return fh;
        temporarios += 1;
        if (temporarios !== v.alvo || v.tipo === 'link') return fh;
        let blocos = 0;
        return new Proxy(fh, {
          get(t, p) {
            const f = t[p];
            if (typeof f !== 'function') return f;
            if (p === 'write' && v.tipo === 'escrita') return async (...a) => { if (blocos >= v.apos) throw enospc(); blocos += 1; return f.apply(t, a); };
            if (p === 'sync' && v.tipo === 'sync') return async () => { throw enospc(); };
            return f.bind(t);
          },
        });
      };
      promessas.link = async (...a) => { ligacoes += 1; if (v.tipo === 'link' && ligacoes === v.alvo) throw enospc(); return ligar(...a); };
      let r;
      try { r = await x.novo({ cliente }).baixar(x.pedido()); } finally { promessas.open = abrir; promessas.link = ligar; }
      falha(r, 'BAIXAR', 'ESPACO_INSUFICIENTE');
      assert.equal(x.lidos(), v.lidos, `${v.nome}: nenhum objeto é baixado depois da falha`);
      assert.equal(fs.existsSync(path.join(dados, v.alvo === 1 ? 'a.enc' : 'sub', 'b.enc')), false, `${v.nome}: o arquivo que falhou não é publicado`);
      if (v.alvo === 2) assert.ok(fs.readFileSync(path.join(dados, 'a.enc')).equals(ARQUIVOS[1].conteudo), `${v.nome}: o arquivo já publicado fica intacto`);
      const tmp = arvore(destino).filter((f) => f.endsWith('.tmp')).map((f) => path.basename(f)).sort();
      assert.deepEqual(tmp, Object.keys(alheios).sort(), `${v.nome}: nenhum temporário próprio sobra e nenhum alheio some`);
      for (const [nome, conteudo] of Object.entries(alheios)) assert.equal(fs.readFileSync(path.join(dados, nome), 'utf8'), conteudo, `${v.nome}: ${nome}`);
      assert.deepEqual(fs.readdirSync(x.fora), [], v.nome);
    }
  });

  test('DWN-08 — colisão do nome final (criado depois da conferência inicial ou no meio do fluxo): o arquivo existente nunca é tocado e o temporário próprio some; nome do destino em uso é recusado', async () => {
    for (const quando of ['leitura', 'fluxo']) {
      const x = await cenario();
      const final = path.join(x.dl.raiz, 'cont', 'dados', 'a.enc');
      const cliente = comAcao(x, quando, () => fs.writeFileSync(final, 'preexistente', { mode: 0o600 }));
      falha(await x.novo({ cliente }).baixar(x.pedido()), 'BAIXAR', 'NOME_FINAL_EXISTENTE');
      assert.equal(fs.readFileSync(final, 'utf8'), 'preexistente', quando);
      semTemporarios(path.join(x.dl.raiz, 'cont'));
    }
    const y = await cenario();
    fs.mkdirSync(path.join(y.dl.raiz, 'cont'), { mode: 0o700 });
    falha(await y.b.baixar(y.pedido()), 'DESTINO', 'DESTINO_EXISTENTE');
    fs.rmdirSync(path.join(y.dl.raiz, 'cont'));
    fs.symlinkSync(y.fora, path.join(y.dl.raiz, 'cont'));
    falha(await y.b.baixar(y.pedido()), 'DESTINO', 'DESTINO_EXISTENTE');
    fs.rmSync(path.join(y.dl.raiz, 'cont'));
    fs.writeFileSync(path.join(y.dl.raiz, 'cont'), 'arquivo', { mode: 0o600 });
    falha(await y.b.baixar(y.pedido()), 'DESTINO', 'DESTINO_EXISTENTE');
    assert.deepEqual(fs.readdirSync(y.fora), []);
    assert.equal(y.lidos(), 0);
  });
});

describe('[DWN] espaço livre e limites de tamanho ANTES de gravar', () => {
  test('DWN-09 — espaço: necessário mais margem (10% ou 64 MiB, o maior); um byte a menos recusa; a reserva para a decifra dobra a necessidade; nada é criado nem lido', async () => {
    const ok = TOTAL + MARGEM;
    const x = await cenario({ baixador: { portas: { statfs: statfsCom(ok - 1) } } });
    falha(await x.b.baixar(x.pedido()), 'ESPACO', 'ESPACO_INSUFICIENTE');
    nada(x);
    const y = await cenario({ baixador: { portas: { statfs: statfsCom(ok) } } });
    assert.equal((await y.b.baixar(y.pedido())).ok, true, 'exatamente necessário mais margem basta');
    const z = await cenario({ baixador: { portas: { statfs: statfsCom(ok + 100) } } });
    falha(await z.b.baixar(z.pedido({ reservarDecifra: true })), 'ESPACO', 'ESPACO_INSUFICIENTE');
    nada(z);
    const w = await cenario({ baixador: { portas: { statfs: statfsCom(2 * TOTAL + MARGEM) } } });
    assert.equal((await w.b.baixar(w.pedido({ reservarDecifra: true }))).ok, true);
    const grande = await cenario({ baixador: { portas: { statfs: statfsCom(10 * 1024 ** 3), }, limites: { totalBytesMaximo: 2 ** 40 } } });
    const consolidado = JSON.parse(JSON.stringify(grande.c.consolidado));
    for (const r of consolidado.recibos) r.bytes = 4 * 1024 ** 3;
    falha(await grande.b.baixar(grande.pedido({ consolidado })), 'ESPACO', 'ESPACO_INSUFICIENTE');
    assert.equal(Math.max(Math.ceil(3 * 4 * 1024 ** 3 * 0.1), MARGEM) > MARGEM, true, 'a margem proporcional prevalece em conjuntos grandes');
  });

  test('DWN-10 — inodes insuficientes e espaço indeterminável (falha da consulta, resposta inválida) recusam; sistema que não informa inodes não bloqueia', async () => {
    const livre = TOTAL + MARGEM + 1;
    const x = await cenario({ baixador: { portas: { statfs: statfsCom(livre, { ffree: 1029 }) } } });
    falha(await x.b.baixar(x.pedido()), 'ESPACO', 'INODES_INSUFICIENTES');
    nada(x);
    const y = await cenario({ baixador: { portas: { statfs: statfsCom(livre, { ffree: 1030 }) } } });
    assert.equal((await y.b.baixar(y.pedido())).ok, true);
    const z = await cenario({ baixador: { portas: { statfs: statfsCom(livre, { files: 0, ffree: 0 }) } } });
    assert.equal((await z.b.baixar(z.pedido())).ok, true);
    for (const statfs of [async () => { throw new Error('detalhe-interno-secreto'); }, async () => ({ bsize: 'x', bavail: 'y' }), async () => null, async () => ({ bsize: 1, bavail: -5, files: 1, ffree: 1 })]) {
      const w = await cenario({ baixador: { portas: { statfs } } });
      const r = await w.b.baixar(w.pedido());
      falha(r, 'ESPACO', 'ESPACO_INDETERMINADO');
      assert.equal(JSON.stringify(r).includes('secreto'), false);
      nada(w);
    }
  });

  test('DWN-11 — limites: total e número de arquivos acima do teto recusam sem criar nada; no limite exato passa; limites inválidos e porta de espaço fora de teste são recusados na criação', async () => {
    const x = await cenario({ baixador: { limites: { totalBytesMaximo: TOTAL - 1 } } });
    falha(await x.b.baixar(x.pedido()), 'LIMITE', 'LIMITE_TOTAL_EXCEDIDO');
    nada(x);
    const y = await cenario({ baixador: { limites: { totalBytesMaximo: TOTAL } } });
    assert.equal((await y.b.baixar(y.pedido())).ok, true);
    const z = await cenario({ baixador: { limites: { totalBytesMaximo: 2 ** 30, arquivosMaximo: 2 } } });
    falha(await z.b.baixar(z.pedido()), 'LIMITE', 'LIMITE_DE_ARQUIVOS_EXCEDIDO');
    nada(z);
    const w = await cenario();
    for (const limites of [undefined, null, {}, { totalBytesMaximo: 0 }, { totalBytesMaximo: -1 }, { totalBytesMaximo: 1.5 }, { totalBytesMaximo: '10' }, { totalBytesMaximo: 2 ** 53 }, { totalBytesMaximo: 10, arquivosMaximo: 0 }, { totalBytesMaximo: 10, arquivosMaximo: 400001 }, { totalBytesMaximo: 10, extra: 1 }]) {
      assert.throws(() => w.novo({ limites }), (e) => e.code === 'CONFIGURACAO_INVALIDA', JSON.stringify(limites));
    }
    assert.throws(() => w.novo({ portas: { statfs: 'x' } }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.throws(() => w.novo({ portas: { statfs: statfsCom(1), extra: 1 } }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => w.novo({ portas: { statfs: statfsCom(1) } }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    } finally { process.env.NODE_ENV = antes; }
  });
});

describe('[DWN] entradas não confiáveis', () => {
  test('DWN-12 — nome do destino, raiz e forma do pedido inválidos são recusados antes de qualquer consulta ou criação', async () => {
    const x = await cenario();
    const nomes = ['..', '.', 'a/b', '', '.oculto', 'a b', 'x'.repeat(129), 'a\0b', '../fora', 7, null, undefined];
    for (const nome of nomes) falha(await x.b.baixar(x.pedido({ nome })), 'ENTRADA', 'ENTRADA_INVALIDA');
    for (const r of ['relativo', '/', `${x.dl.raiz}/`, `${x.dl.raiz}/../${path.basename(x.dl.raiz)}`, `${x.dl.raiz}\0`, 7, null]) falha(await x.b.baixar(x.pedido({ raiz: r })), 'ENTRADA', 'ENTRADA_INVALIDA');
    for (const extra of [{ extra: 1 }, { destinoLocalId: 7 }, { destinoLocalId: undefined }, { reservarDecifra: 'sim' }, { consolidado: 'texto' }, { consolidado: null }]) falha(await x.b.baixar(x.pedido(extra)), 'ENTRADA', 'ENTRADA_INVALIDA');
    falha(await x.b.baixar(null), 'ENTRADA', 'ENTRADA_INVALIDA');
    nada(x);
  });

  test('DWN-13 — consolidado hostil: chave com traversal, fora do conjunto, de outro bucket, de outro destino, bytes absurdos; o texto dele nunca vira caminho sem validação', async () => {
    const x = await cenario();
    const alterar = (mutar) => { const c = JSON.parse(JSON.stringify(x.c.consolidado)); mutar(c); return c; };
    const invalidos = [
      alterar((c) => { c.recibos[1].chave = 'hml/c1/../../fora/x'; }),
      alterar((c) => { c.recibos[1].chave = 'hml/c1/dados/..'; }),
      alterar((c) => { c.recibos[1].chave = 'hml/c1//dados'; }),
      alterar((c) => { c.recibos[1].chave = 'hml/outro-conjunto/dados/a.enc'; }),
      alterar((c) => { c.recibos[1].chave = '/etc/passwd'; }),
      alterar((c) => { c.recibos[1].bucket = 'safework-hml-backup-999999999999'; }),
      alterar((c) => { c.recibos[1].sha256 = 'xyz'; }),
      alterar((c) => { c.recibos[1].bytes = -1; }),
      alterar((c) => { c.recibos = []; }),
    ];
    for (const consolidado of invalidos) falha(await x.b.baixar(x.pedido({ consolidado })), 'ENTRADA', 'CONSOLIDADO_INVALIDO');
    const outroDestino = alterar((c) => { c.destinoId = 'prod-s3-principal'; c.ambiente = 'PRODUCAO'; c.recibos.forEach((r) => { r.destinoId = 'prod-s3-principal'; r.ambiente = 'PRODUCAO'; r.chave = r.chave.replace('hml/', 'prod/'); r.bucket = 'safework-prod-backup-222222222222'; }); });
    falha(await x.b.baixar(x.pedido({ consolidado: outroDestino })), 'ENTRADA', 'DESTINO_DIVERGENTE');
    const enorme = alterar((c) => { c.recibos.forEach((r) => { r.bytes = 5 * 1024 ** 3; }); });
    falha(await x.b.baixar(x.pedido({ consolidado: enorme })), 'LIMITE', 'LIMITE_TOTAL_EXCEDIDO');
    nada(x);
    assert.equal(Rb.consolidarRecibos({ destinoId: x.c.consolidado.destinoId, ambiente: x.c.consolidado.ambiente, conjuntoId: 'c1', recibos: [] }).ok, false);
  });

  test('DWN-14 — a credencial tem de ser a de RESTAURAÇÃO: a do publicador diverge e nada é lido nem criado; falha ao consultar não ecoa', async () => {
    const x = await cenario();
    const errado = { identidade: x.a.s3.clientes.publicador.identidade, lerVersao: x.a.s3.clientes.restauracao.lerVersao };
    falha(await x.novo({ cliente: errado }).baixar(x.pedido()), 'IDENTIDADE', 'IDENTIDADE_DIVERGENTE');
    nada(x);
    const quebrado = { ...x.a.s3.clientes.restauracao, identidade: async () => { throw new Error('detalhe-interno-secreto'); } };
    const r = await x.novo({ cliente: quebrado }).baixar(x.pedido());
    falha(r, 'IDENTIDADE', 'FALHA_AO_CONSULTAR');
    assert.equal(JSON.stringify(r).includes('secreto'), false);
    nada(x);
  });

  test('DWN-15 — objeto ausente, erro de leitura, resposta fora do contrato, fluxo que cai no meio e atraso: códigos fixos, sem eco e sem temporários', async () => {
    const casos = (base) => [
      [async () => { throw Object.assign(new Error('x'), { code: 'NAO_ENCONTRADO' }); }, 'OBJETO_AUSENTE'],
      [async () => { throw new Error('detalhe-interno-secreto'); }, 'LEITURA_FALHOU'],
      [async () => null, 'LEITURA_FALHOU'],
      [async () => ({ bytes: 'x', fluxo: [] }), 'LEITURA_FALHOU'],
      [async (p) => { const r = await base.lerVersao(p); return { bytes: r.bytes, fluxo: (async function* cai() { yield Buffer.from('parcial'); throw new Error('detalhe-interno-secreto'); }()) }; }, 'LEITURA_FALHOU'],
      [async () => new Promise(() => {}), 'LEITURA_FALHOU'],
      [async (p) => { const r = await base.lerVersao(p); return { bytes: r.bytes, fluxo: (async function* lento() { await new Promise(() => {}); yield Buffer.alloc(0); }()) }; }, 'LEITURA_FALHOU'],
    ];
    for (let i = 0; i < 7; i += 1) {
      const y = await cenario();
      const [lerVersao, codigo] = casos(y.a.s3.clientes.restauracao)[i];
      const r = await y.novo({ cliente: { ...y.a.s3.clientes.restauracao, lerVersao }, prazoMs: 40 }).baixar(y.pedido());
      falha(r, 'BAIXAR', codigo);
      assert.equal(JSON.stringify(r).includes('secreto'), false);
      semTemporarios(path.join(y.dl.raiz, 'cont'));
      assert.deepEqual(fs.readdirSync(y.fora), []);
    }
  });
});

describe('[DWN] autorização do segundo destino (decifra) e invariantes do módulo', () => {
  test('DWN-16 — autorizarNovoDestino: filho novo e livre da raiz autorizada passa; em uso, fora da lista, protegido, nome inválido ou raiz errada são recusados; nada é criado', async () => {
    const x = await cenario();
    const ok = await x.b.autorizarNovoDestino({ destinoLocalId: x.dl.id, raiz: x.dl.raiz, nome: 'decifrado' });
    assert.deepEqual({ ok: ok.ok, caminho: ok.caminho, origem: ok.origemDoDestino }, { ok: true, caminho: path.join(x.dl.raiz, 'decifrado'), origem: 'TESTE_CONTROLADO' });
    assert.deepEqual(fs.readdirSync(x.dl.raiz), []);
    fs.mkdirSync(path.join(x.dl.raiz, 'ocupado'), { mode: 0o700 });
    falha(await x.b.autorizarNovoDestino({ destinoLocalId: x.dl.id, raiz: x.dl.raiz, nome: 'ocupado' }), 'DESTINO', 'DESTINO_EXISTENTE');
    falha(await x.b.autorizarNovoDestino({ destinoLocalId: 'nao-listado', raiz: x.dl.raiz, nome: 'decifrado' }), 'DESTINO', 'DESTINO_NAO_AUTORIZADO');
    falha(await x.b.autorizarNovoDestino({ destinoLocalId: x.dl.id, raiz: x.dl.raiz, nome: '../x' }), 'ENTRADA', 'ENTRADA_INVALIDA');
    falha(await x.b.autorizarNovoDestino({ destinoLocalId: x.dl.id, raiz: x.pai, nome: 'decifrado' }), 'DESTINO', 'RAIZ_DIFERENTE_DA_AUTORIZADA');
    falha(await x.novo({ protegidos: [x.dl.raiz] }).autorizarNovoDestino({ destinoLocalId: x.dl.id, raiz: x.dl.raiz, nome: 'decifrado' }), 'DESTINO', 'DESTINO_PROTEGIDO');
    falha(await x.b.autorizarNovoDestino({ destinoLocalId: x.dl.id, raiz: x.dl.raiz }), 'ENTRADA', 'ENTRADA_INVALIDA');
  });

  test('DWN-17 — privilégio mínimo e invariantes: cliente de restauração só tem identidade e leitura por versão; opções estritas; destino durável só pela ficha; o módulo consulta o registro oficial de destinos e não usa ambiente, SDK, rede nem processo', async () => {
    const x = await cenario();
    assert.deepEqual(Object.keys(x.a.s3.clientes.restauracao).sort(), ['identidade', 'lerVersao']);
    const base = { destinoId: x.a.ficha.id, ambiente: 'HOMOLOGACAO', cliente: x.a.s3.clientes.restauracao, validadorDeDestinos: x.dl.validador, limites: { totalBytesMaximo: 1000 } };
    assert.throws(() => D.criarBaixadorDuravel(base), (e) => e.code === 'DESTINO_DURAVEL_NAO_AUTORIZADO');
    for (const ruim of [null, {}, { ...base, extra: 1, registro: x.a.reg }, { ...base, cliente: {}, registro: x.a.reg }, { ...base, prazoMs: 0, registro: x.a.reg }, { ...base, validadorDeDestinos: undefined, registro: x.a.reg }, { ...base, limites: undefined, registro: x.a.reg }, { ...base, protegidos: ['relativo'], registro: x.a.reg }, { ...base, protegidos: 'x', registro: x.a.reg }]) {
      assert.throws(() => D.criarBaixadorDuravel(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    }
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-baixador-duravel.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    assert.match(fonte, /require\('\.\/imagem-backup-destinos\.service'\)/);
    assert.match(fonte, /ehDestinoValidado/);
    assert.match(fonte, /verificarNomeLivre/);
    assert.match(fonte, /contem\(/);
    assert.equal(/process\.env|@aws-sdk|require\(['"]node:(?:net|http|https|child_process|dns|tls)|\.delete\(|DeleteObject|gravarObjeto|spawn\s*\(|exec\s*\(/.test(fonte), false);
    assert.equal(/\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/.test(fonte), false);
  });

  test('DWN-18 — sinais de escrita e remoção do módulo continuam EXATAMENTE os da entrada proposta da guarda P2 (mkdir 1, link 1, O_CREAT 1, O_WRONLY 1; rm 1): a correção não acrescentou nenhum', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-baixador-duravel.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    const contar = (re) => { const mapa = {}; for (const m of fonte.matchAll(re)) { const s = m[0].replace(/\s*\($/, '').toLowerCase(); mapa[s] = (mapa[s] ?? 0) + 1; } return mapa; };
    const escrita = /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/g;
    const remocao = /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/g;
    assert.deepEqual(contar(escrita), { link: 1, mkdir: 1, o_creat: 1, o_wronly: 1 });
    assert.deepEqual(contar(remocao), { rm: 1 });
  });
});
