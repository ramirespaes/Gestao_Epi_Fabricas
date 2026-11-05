'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/services/backup-contencao-destino.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { criarValidadorDeDestinos } = require('../../src/services/imagem-backup-destinos.service');
const { ambienteS3 } = require('../helpers/ambiente-s3-falso');
const { pacoteSintetico, arvore, novaRaiz, limparRaizes } = require('../helpers/pacote-l2-sintetico');

/**
 * R-D45 [CON] e [DEC]: contenção da DECIFRAGEM (entrada 47) dentro da raiz AUTORIZADA, inclusive diante de troca concorrente, e falha fechada diante de ENOSPC.
 * A troca é provocada no último ponto observável ANTES do uso (a sorteio do nome do temporário, imediatamente antes do `open`): a conferência tem de pegá-la. Dados SINTÉTICOS.
 */

after(limparRaizes);
const SEG_MAC = crypto.randomBytes(32);
const SEG_KEK = crypto.randomBytes(32);
const fonteMac = () => H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-1', segredo: SEG_MAC }] });
const fonteCifra = () => E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-1', segredo: SEG_KEK }] });
const chaves = () => ({ cifra: { fonte: fonteCifra(), chaveId: 'kek-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' } });
const promessas = require('node:fs/promises');

/** Raiz autorizada de TESTE, uma pasta `destino` (filha direta) e uma pasta `fora` que NUNCA pode receber nada. */
function leve() {
  const raiz = novaRaiz();
  const dl = ambienteS3().destinoLocal(raiz);
  const fora = path.join(raiz, 'fora');
  fs.mkdirSync(fora, { mode: 0o700 });
  const destino = path.join(dl.raiz, 'dec');
  const contencao = (extra = {}) => C.criarContencaoDeDestino({ validadorDeDestinos: dl.validador, destinoLocalId: dl.id, raiz: dl.raiz, destino, ...extra });
  return { raiz, dl, fora, destino, contencao };
}
/** Cenário completo: pacote L2 sintético cifrado em contêiner e o destino da decifra. */
async function cenario() {
  const x = leve();
  const pacote = pacoteSintetico(x.raiz, { fonteMac: fonteMac(), macId: 'mac-1' });
  const container = path.join(x.raiz, 'container');
  const c = await E.cifrarPacote({ pacote: pacote.dir, lido: pacote.lido, destino: container, ...chaves() });
  assert.equal(c.ok, true, JSON.stringify(c.falha));
  const primeiro = arvore(pacote.dir)[0];
  return { ...x, pacote, container, primeiro, pastaDoPrimeiro: path.join(x.destino, path.dirname(primeiro)), decifrar: (extra = {}) => E.decifrarContainer({ container, destino: x.destino, ...chaves(), ...extra }) };
}
/** Executa `acao` na N-ésima gravação de temporário: depois de as pastas terem sido conferidas e imediatamente antes do `open`. */
async function naGravacao(n, acao, executar) {
  const original = crypto.randomBytes;
  let i = 0;
  crypto.randomBytes = (tamanho, ...resto) => { if (tamanho === 8) { i += 1; if (i === n) acao(); } return original(tamanho, ...resto); };
  try { return await executar(); } finally { crypto.randomBytes = original; }
}
const trocas = {
  'pasta vira link para fora': (x) => () => { const d = x.pastaDoPrimeiro; fs.renameSync(d, `${d}.orig`); fs.symlinkSync(x.fora, d); },
  'pasta vira outra pasta real': (x) => () => { const d = x.pastaDoPrimeiro; fs.renameSync(d, `${d}.orig`); fs.mkdirSync(d, { mode: 0o700 }); },
  'destino vira link para fora': (x) => () => { fs.renameSync(x.destino, `${x.destino}.orig`); fs.symlinkSync(x.fora, x.destino); },
  'raiz autorizada vira outra pasta': (x) => () => { fs.renameSync(x.dl.raiz, `${x.dl.raiz}.orig`); fs.mkdirSync(x.dl.raiz, { mode: 0o700 }); },
  'raiz autorizada ganha acesso de grupo e outros': (x) => () => fs.chmodSync(x.dl.raiz, 0o755),
};
const falha = (r, passo, codigo) => assert.deepEqual({ ok: r.ok, falha: r.falha }, { ok: false, falha: { passo, codigo } });
const enospc = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
/** Faz o N-ésimo temporário aberto sob `prefixo` falhar com ENOSPC na gravação (`writeFile` ou `write`) ou no `sync`. */
function falharAoGravar(prefixo, alvo, em) {
  const original = promessas.open;
  let contador = 0;
  promessas.open = async (caminho, ...resto) => {
    const fh = await original(caminho, ...resto);
    const c = String(caminho);
    if (!c.startsWith(prefixo) || !c.endsWith('.tmp')) return fh;
    contador += 1;
    if (contador !== alvo) return fh;
    return new Proxy(fh, {
      get(t, p) {
        const v = t[p];
        if (typeof v !== 'function') return v;
        if ((p === 'write' || p === 'writeFile') && em === 'escrita') return async () => { throw enospc(); };
        if (p === 'sync' && em === 'sync') return async () => { throw enospc(); };
        return v.bind(t);
      },
    });
  };
  return () => { promessas.open = original; };
}

describe('[CON] guarda de contenção do destino (raiz autorizada + pastas criadas)', () => {
  test('CON-01 — opções estritas: validador oficial, id, raiz e destino canônicos; o destino é filho DIRETO da raiz', () => {
    const x = leve();
    const ok = { validadorDeDestinos: x.dl.validador, destinoLocalId: x.dl.id, raiz: x.dl.raiz, destino: x.destino };
    assert.equal(typeof C.criarContencaoDeDestino(ok).conferir, 'function');
    const ruins = [null, {}, { ...ok, extra: 1 }, { ...ok, validadorDeDestinos: {} }, { ...ok, validadorDeDestinos: { validar: () => ({}) } }, { ...ok, destinoLocalId: 7 }, { ...ok, raiz: 'relativo' }, { ...ok, destino: 'relativo' },
      { ...ok, destino: x.dl.raiz }, { ...ok, destino: path.join(x.dl.raiz, 'a', 'b') }, { ...ok, destino: path.join(path.dirname(x.dl.raiz), 'irmao') }, { ...ok, destino: `${x.destino}/` }];
    for (const r of ruins) assert.throws(() => C.criarContencaoDeDestino(r), (e) => e.code === 'CONFIGURACAO_INVALIDA', JSON.stringify(r));
  });

  test('CON-02 — a raiz é revalidada a CADA conferência (sem cache) e só vale se continuar exatamente a autorizada; id fora da lista, lista real vazia e validador forjado nunca conferem', async () => {
    const x = leve();
    const c = x.contencao();
    assert.equal(await c.conferir(x.dl.raiz), true);
    assert.equal(await c.conferir(x.fora), false);
    assert.equal(await c.conferir(7), false);
    assert.equal(await c.conferir(x.destino), false, 'pasta não registrada nunca confere');
    fs.chmodSync(x.dl.raiz, 0o755);
    assert.equal(await c.conferir(x.dl.raiz), false);
    fs.chmodSync(x.dl.raiz, 0o700);
    assert.equal(await c.conferir(x.dl.raiz), true, 'sem cache: voltou a valer ao restaurar o modo');
    assert.equal(await x.contencao({ destinoLocalId: 'nao-listado' }).conferir(x.dl.raiz), false);
    assert.equal(await x.contencao({ validadorDeDestinos: criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO' }) }).conferir(x.dl.raiz), false);
    const literal = { ambiente: 'HOMOLOGACAO', validar: () => ({ autorizado: true, motivo: null, destinoId: x.dl.id, ambiente: 'HOMOLOGACAO', origem: 'OPERACIONAL', raiz: x.dl.raiz }) };
    assert.equal(await x.contencao({ validadorDeDestinos: literal }).conferir(x.dl.raiz), false);
    assert.equal(await x.contencao({ validadorDeDestinos: { ambiente: 'HOMOLOGACAO', validar: () => { throw new Error('x'); } } }).conferir(x.dl.raiz), false);
  });

  test('CON-03 — registrar: só pasta real do usuário, dentro da raiz, filha direta (destino) ou filha de pasta já registrada e intacta; link, arquivo, fora da raiz e pai não registrado são recusados', async () => {
    const x = leve();
    const c = x.contencao();
    fs.mkdirSync(x.destino, { mode: 0o700 });
    const filha = path.join(x.destino, 'a');
    fs.mkdirSync(filha, { mode: 0o700 });
    assert.equal(await c.registrar(filha), false, 'pai ainda não registrado');
    assert.equal(await c.registrar(x.destino), true);
    assert.equal(await c.registrar(filha), true);
    assert.equal(await c.conferir(filha), true);
    assert.equal(await c.registrar(x.fora), false);
    fs.mkdirSync(path.join(x.dl.raiz, 'outro'), { mode: 0o700 });
    assert.equal(await c.registrar(path.join(x.dl.raiz, 'outro')), false, 'irmã do destino, mesmo real e dentro da raiz, não é registrada');
    assert.equal(await c.registrar(x.dl.raiz), false);
    fs.symlinkSync(x.fora, path.join(x.destino, 'elo'));
    assert.equal(await c.registrar(path.join(x.destino, 'elo')), false);
    fs.writeFileSync(path.join(x.destino, 'arquivo'), 'x');
    assert.equal(await c.registrar(path.join(x.destino, 'arquivo')), false);
    assert.equal(await c.registrar(path.join(x.destino, 'nao-existe')), false);
    assert.equal(await c.registrar(undefined), false);
  });

  test('CON-04 — depois de registradas, a troca de qualquer pasta da cadeia (por link, por outra pasta real, remoção, ou da pasta pai) faz a conferência falhar', async () => {
    const preparar = async () => {
      const x = leve();
      const c = x.contencao();
      fs.mkdirSync(x.destino, { mode: 0o700 });
      const filha = path.join(x.destino, 'a');
      const neta = path.join(filha, 'b');
      fs.mkdirSync(filha, { mode: 0o700 });
      fs.mkdirSync(neta, { mode: 0o700 });
      assert.deepEqual([await c.registrar(x.destino), await c.registrar(filha), await c.registrar(neta)], [true, true, true]);
      assert.equal(await c.conferir(neta), true);
      return { x, c, filha, neta };
    };
    const casos = {
      'neta vira link': ({ x, neta }) => { fs.renameSync(neta, `${neta}.orig`); fs.symlinkSync(x.fora, neta); },
      'neta vira outra pasta': ({ neta }) => { fs.renameSync(neta, `${neta}.orig`); fs.mkdirSync(neta, { mode: 0o700 }); },
      'neta removida': ({ neta }) => fs.rmdirSync(neta),
      'filha vira link para pasta com a mesma estrutura': ({ x, filha }) => { fs.mkdirSync(path.join(x.fora, 'b')); fs.renameSync(filha, `${filha}.orig`); fs.symlinkSync(x.fora, filha); },
      'destino vira outra pasta': ({ x }) => { fs.renameSync(x.destino, `${x.destino}.orig`); fs.mkdirSync(path.join(x.destino, 'a', 'b'), { recursive: true, mode: 0o700 }); },
    };
    for (const [nome, trocar] of Object.entries(casos)) {
      const p = await preparar();
      trocar(p);
      assert.equal(await p.c.conferir(p.neta), false, nome);
    }
  });
});

describe('[DEC] decifragem (entrada 47) contida na raiz autorizada', () => {
  test('DEC-01 — com contenção a decifra conclui e reproduz o pacote; sem contenção o comportamento anterior é o mesmo; contenção malformada ou chave extra é recusada', async () => {
    const x = await cenario();
    const r = await x.decifrar({ contencao: x.contencao() });
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.deepEqual(arvore(x.destino), arvore(x.pacote.dir));
    for (const f of arvore(x.pacote.dir)) assert.ok(fs.readFileSync(path.join(x.destino, f)).equals(fs.readFileSync(path.join(x.pacote.dir, f))), f);
    const y = await cenario();
    const sem = await y.decifrar();
    assert.equal(sem.ok, true, JSON.stringify(sem.falha));
    const z = await cenario();
    for (const ruim of [{ contencao: {} }, { contencao: { conferir() {} } }, { contencao: 'x' }, { contencao: null }, { extra: 1 }]) falha(await z.decifrar(ruim), 'ENTRADA', 'ENTRADA_INVALIDA');
    assert.equal(fs.existsSync(z.destino), false);
  });

  test('DEC-02 — CONTROLE: SEM contenção, a mesma troca (pasta vira link para fora, logo antes do open) redireciona a gravação para FORA; é a lacuna que a contenção fecha', async () => {
    const x = await cenario();
    const r = await naGravacao(1, trocas['pasta vira link para fora'](x), () => x.decifrar());
    assert.equal(r.ok, false);
    assert.ok(fs.readdirSync(x.fora).includes('mestre.png'), 'o arquivo decifrado foi parar fora da raiz autorizada');
  });

  test('DEC-03 — COM contenção, cada troca (na primeira ou na segunda gravação) para a decifra com DESTINO_ALTERADO; NENHUM temporário é aberto depois da troca e NADA chega ao destino do link nem à pasta substituta', async () => {
    for (const n of [1, 2]) {
      for (const [nome, fazer] of Object.entries(trocas)) {
        const x = await cenario();
        const abertas = [];
        let trocou = false;
        const abrir = promessas.open;
        promessas.open = async (caminho, flags, ...resto) => { if (trocou && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0) abertas.push(String(caminho)); return abrir(caminho, flags, ...resto); };
        let r;
        try { r = await naGravacao(n, () => { trocou = true; fazer(x)(); }, () => x.decifrar({ contencao: x.contencao() })); } finally { promessas.open = abrir; }
        assert.equal(trocou, true, nome);
        assert.deepEqual(abertas, [], `${nome} (gravação ${n}): nenhuma abertura de escrita depois da troca`);
        falha(r, 'DECIFRA', 'DESTINO_ALTERADO');
        assert.deepEqual(fs.readdirSync(x.fora), [], `${nome} (gravação ${n})`);
        if (nome === 'raiz autorizada vira outra pasta') assert.deepEqual(fs.readdirSync(x.dl.raiz), [], `${nome} (gravação ${n}): a pasta nova não recebe nada`);
        if (nome === 'pasta vira outra pasta real') assert.deepEqual(fs.readdirSync(x.pastaDoPrimeiro), [], `${nome} (gravação ${n})`);
      }
    }
  });

  test('DEC-03b — troca NO MEIO da gravação (depois de aberto o temporário, quando o contêiner começa a ser lido): o link é recusado (DESTINO_ALTERADO), nada é ligado fora e o nome final não é publicado', async () => {
    for (const nome of ['pasta vira link para fora', 'pasta vira outra pasta real', 'destino vira link para fora', 'raiz autorizada vira outra pasta', 'raiz autorizada ganha acesso de grupo e outros']) {
      const x = await cenario();
      const abrir = promessas.open;
      const ligar = promessas.link;
      let feito = false;
      let ligacoes = 0;
      promessas.open = async (caminho, flags, ...resto) => {
        if (!feito && String(caminho).startsWith(x.container) && String(caminho).endsWith('.enc') && fs.existsSync(x.pastaDoPrimeiro)) { feito = true; trocas[nome](x)(); }
        return abrir(caminho, flags, ...resto);
      };
      promessas.link = async (...a) => { ligacoes += 1; return ligar(...a); };
      let r;
      try { r = await x.decifrar({ contencao: x.contencao() }); } finally { promessas.open = abrir; promessas.link = ligar; }
      assert.equal(feito, true, nome);
      falha(r, 'DECIFRA', 'DESTINO_ALTERADO');
      assert.equal(ligacoes, 0, `${nome}: nenhum arquivo foi ligado`);
      assert.deepEqual(fs.readdirSync(x.fora), [], nome);
      assert.equal(fs.existsSync(path.join(x.pastaDoPrimeiro, 'mestre.png')), false, nome);
    }
  });

  test('DEC-03c — troca ANTES de criar uma subpasta (a pasta pai vira outra pasta real, logo antes da conferência): a subpasta NÃO é criada na pasta impostora', async () => {
    const preparar = async () => {
      const x = await cenario();
      const imagens = path.join(x.destino, 'arquivos', 'imagens');
      let trocou = false;
      const original = promessas.lstat;
      promessas.lstat = async (caminho, ...resto) => {
        if (!trocou && String(caminho) === path.join(imagens, 'padrao')) { trocou = true; fs.renameSync(imagens, `${imagens}.orig`); fs.mkdirSync(imagens, { mode: 0o700 }); }
        return original(caminho, ...resto);
      };
      return { x, imagens, restaurar: () => { promessas.lstat = original; }, trocou: () => trocou };
    };
    const comGuarda = await preparar();
    let r;
    try { r = await comGuarda.x.decifrar({ contencao: comGuarda.x.contencao() }); } finally { comGuarda.restaurar(); }
    assert.equal(comGuarda.trocou(), true);
    assert.equal(r.ok, false);
    assert.deepEqual(fs.readdirSync(comGuarda.imagens), [], 'a subpasta não foi criada dentro da pasta impostora');
    const controle = await preparar();
    let c;
    try { c = await controle.x.decifrar(); } finally { controle.restaurar(); }
    assert.equal(controle.trocou(), true);
    assert.ok(fs.readdirSync(controle.imagens).length > 0, 'CONTROLE: sem a guarda a subpasta é criada dentro da pasta impostora');
    assert.equal(typeof c.ok, 'boolean');
  });

  test('DEC-04 — raiz autorizada substituída ANTES do primeiro mkdir: sem contenção a decifra escreve na pasta impostora; com contenção é recusada (DESTINO_ALTERADO) e nada é criado', async () => {
    const trocarNaPrimeiraLeitura = async (x, executar) => {
      const original = promessas.lstat;
      let feito = false;
      promessas.lstat = async (caminho, ...resto) => {
        if (!feito && String(caminho) === x.dl.raiz) { feito = true; fs.renameSync(x.dl.raiz, `${x.dl.raiz}.orig`); fs.mkdirSync(x.dl.raiz, { mode: 0o700 }); }
        return original(caminho, ...resto);
      };
      try { return await executar(); } finally { promessas.lstat = original; }
    };
    const controle = await cenario();
    const sem = await trocarNaPrimeiraLeitura(controle, () => controle.decifrar());
    assert.equal(sem.ok, true, 'sem contenção a decifra aceita a pasta impostora');
    assert.equal(fs.existsSync(path.join(controle.dl.raiz, 'dec')), true);
    const x = await cenario();
    const r = await trocarNaPrimeiraLeitura(x, () => x.decifrar({ contencao: x.contencao() }));
    falha(r, 'DESTINO', 'DESTINO_ALTERADO');
    assert.deepEqual(fs.readdirSync(x.dl.raiz), []);
    assert.deepEqual(fs.readdirSync(x.fora), []);
  });

  test('DEC-05 — ENOSPC durante a gravação da decifra: falha fechada; arquivo final não publicado; só o temporário próprio é removido; arquivos alheios e já publicados ficam intactos', async () => {
    for (const em of ['escrita', 'sync']) {
      const x = await cenario();
      const dir = x.pastaDoPrimeiro;
      const alheios = { 'alheio.tmp': 'conteudo-alheio-1', 'miniatura.webp.ffffffffffffffff.tmp': 'conteudo-alheio-2' };
      const restaurar = falharAoGravar(x.destino, 2, em);
      let r;
      try { r = await naGravacao(1, () => { for (const [nome, c] of Object.entries(alheios)) fs.writeFileSync(path.join(dir, nome), c, { mode: 0o600 }); }, () => x.decifrar({ contencao: x.contencao() })); } finally { restaurar(); }
      assert.equal(r.ok, false, em);
      assert.equal(r.falha.passo, 'DECIFRA', em);
      assert.equal(fs.existsSync(path.join(dir, 'miniatura.webp')), false, `${em}: o segundo arquivo não é publicado`);
      assert.ok(fs.readFileSync(path.join(dir, 'mestre.png')).equals(fs.readFileSync(path.join(x.pacote.dir, x.primeiro))), `${em}: o primeiro arquivo, já publicado, fica intacto`);
      const tmp = arvore(x.destino).filter((f) => f.endsWith('.tmp')).map((f) => path.basename(f)).sort();
      assert.deepEqual(tmp, Object.keys(alheios).sort(), `${em}: nenhum temporário próprio sobra e nenhum alheio some`);
      for (const [nome, c] of Object.entries(alheios)) assert.equal(fs.readFileSync(path.join(dir, nome), 'utf8'), c, `${em}: ${nome}`);
      assert.deepEqual(fs.readdirSync(x.fora), []);
    }
  });

  test('DEC-06 — a correção não deslocou nenhuma das 8 ocorrências aprovadas da entrada 47 (linhas 48, 108, 124, 130, 133 e 137) nem mudou o mapa de sinais', () => {
    const arquivo = path.join(__dirname, '..', '..', 'src', 'services', 'backup-fontes-cifra-envelope.service.js');
    const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
    const dizem = (n, re) => assert.match(linhas[n - 1], re, `linha ${n}`);
    dizem(48, /O_WRONLY, O_CREAT/);
    dizem(108, /fsp\.mkdir\(/);
    dizem(124, /O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW/);
    dizem(130, /descritor\.writeFile\(/);
    dizem(133, /fsp\.link\(/);
    dizem(137, /fsp\.rm\(/);
    const texto = linhas.join('\n').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    const contar = (re) => { const mapa = {}; for (const m of texto.matchAll(re)) { const s = m[0].replace(/\s*\($/, '').toLowerCase(); mapa[s] = (mapa[s] ?? 0) + 1; } return mapa; };
    assert.deepEqual(contar(/\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/g), { link: 1, mkdir: 1, o_creat: 2, o_wronly: 2, writefile: 1 });
    assert.deepEqual(contar(/\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/g), { rm: 1 });
  });
});
